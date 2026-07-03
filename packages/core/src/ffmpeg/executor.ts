import { execa, type ResultPromise } from "execa";

/**
 * Thin wrapper around the FFmpeg / ffprobe binaries. We invoke them as external
 * processes (never linked), which keeps this project's MIT license independent
 * of FFmpeg's GPL/LGPL components.
 *
 * Binary paths can be overridden via AIVE_FFMPEG / AIVE_FFPROBE env vars (used
 * by packaged desktop builds that ship their own binaries). Otherwise we rely
 * on `ffmpeg` / `ffprobe` being on PATH.
 */
export const FFMPEG_BIN = process.env.AIVE_FFMPEG || "ffmpeg";
export const FFPROBE_BIN = process.env.AIVE_FFPROBE || "ffprobe";

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/**
 * Extract the meaningful tail of an ffmpeg stderr dump. ffmpeg prints the actual
 * cause (an invalid color, an unparseable filter option, a missing file) on the
 * last few lines after pages of banner/progress noise. We surface that tail in
 * the thrown error message so callers — including the AI driving the editor over
 * MCP — see *why* a render failed and can self-correct, instead of an opaque
 * "Command failed with exit code 1".
 */
export function ffmpegStderrDetail(stderr: string, maxLines = 5, maxChars = 600): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop the version/config banner and benign progress lines.
    .filter((l) => !/^(ffmpeg version|built with|configuration:|lib\w+\s+\d|Input #|Stream #|Press \[q\]|frame=|size=|video:|audio:|Output #|Metadata:)/i.test(l));
  const tail = lines.slice(-maxLines).join(" | ");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** Run ffprobe and return its stdout (typically JSON). */
export async function runFfprobe(args: string[]): Promise<string> {
  try {
    const { stdout } = await execa(FFPROBE_BIN, args, { reject: true });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; shortMessage?: string; message?: string };
    throw new FfmpegError(
      `ffprobe failed: ${e.shortMessage || e.message || "unknown error"}`,
      `${FFPROBE_BIN} ${args.join(" ")}`,
      e.stderr || "",
    );
  }
}

export interface FfmpegRunOptions {
  /** Called with a 0..1 progress fraction when a total duration is known. */
  onProgress?: (fraction: number) => void;
  /** Total output duration in seconds, used to compute progress. */
  totalDuration?: number;
  /** AbortSignal to cancel a long-running render. */
  signal?: AbortSignal;
  /**
   * Working directory. Set this when the filtergraph references files by bare
   * name (LUTs, vidstab transform files) — on Windows, absolute paths with a
   * drive-letter colon cannot be parsed inside a filtergraph, so we cd into the
   * directory and use relative filenames instead.
   */
  cwd?: string;
}

/**
 * Run an ffmpeg command to completion. Parses `-progress pipe:1` output (the
 * caller must include those flags) to report progress.
 */
export async function runFfmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<void> {
  const child: ResultPromise = execa(FFMPEG_BIN, args, {
    reject: true,
    buffer: { stdout: false, stderr: true },
    cancelSignal: opts.signal,
    cwd: opts.cwd,
  });

  if (opts.onProgress && opts.totalDuration && opts.totalDuration > 0 && child.stdout) {
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // ffmpeg emits `out_time_us=<microseconds>` lines under -progress.
        if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
          const raw = Number(line.split("=")[1]);
          if (Number.isFinite(raw)) {
            const seconds = line.startsWith("out_time_us=") ? raw / 1e6 : raw / 1e3;
            const frac = Math.max(0, Math.min(1, seconds / opts.totalDuration!));
            opts.onProgress!(frac);
          }
        }
      }
    });
  }

  try {
    await child;
  } catch (err: unknown) {
    const e = err as { stderr?: string; shortMessage?: string; message?: string; isCanceled?: boolean };
    if (e.isCanceled) {
      throw new FfmpegError("ffmpeg render canceled", `${FFMPEG_BIN} ${args.join(" ")}`, e.stderr || "");
    }
    const detail = ffmpegStderrDetail(e.stderr || "");
    throw new FfmpegError(
      `ffmpeg failed${detail ? `: ${detail}` : `: ${e.shortMessage || e.message || "unknown error"}`}`,
      `${FFMPEG_BIN} ${args.join(" ")}`,
      e.stderr || "",
    );
  }
}

/**
 * Run ffmpeg and return its raw stdout as a Buffer (used by analysis paths that
 * pipe rawvideo to `pipe:1`, e.g. reading the mean RGB of a frame as 3 bytes).
 */
export async function runFfmpegStdoutBuffer(args: string[]): Promise<Buffer> {
  const { stdout } = await execa(FFMPEG_BIN, args, {
    reject: true,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}

/** Run ffmpeg and return combined stderr (used by analysis filters that log to stderr). */
export async function runFfmpegCaptureStderr(args: string[]): Promise<string> {
  try {
    const result = await execa(FFMPEG_BIN, args, { reject: false, all: false });
    return result.stderr ?? "";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return e.stderr ?? e.message ?? "";
  }
}

/** Verify ffmpeg & ffprobe are available; returns their version banner lines. */
export async function checkBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const [ff, fp] = await Promise.all([
    execa(FFMPEG_BIN, ["-version"]).then((r) => r.stdout.split("\n")[0]),
    execa(FFPROBE_BIN, ["-version"]).then((r) => r.stdout.split("\n")[0]),
  ]);
  return { ffmpeg: ff, ffprobe: fp };
}
