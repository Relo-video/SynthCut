import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { ensureWhisper, DEFAULT_MODEL, type WhisperModel } from "./setup.js";

/** A single transcribed caption cue. Times are seconds relative to the audio. */
export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOptions {
  /** ggml model to use (downloaded on first use). Default base.en. */
  model?: WhisperModel;
  /** Spoken language, or "auto" to detect. Default "en". */
  language?: string;
  /**
   * Maximum characters per cue. Short cues read better as on-screen captions.
   * Default 32 (with split-on-word so words aren't broken mid-token).
   */
  maxLen?: number;
  /** Number of CPU threads. Default: leave to whisper's own default. */
  threads?: number;
}

/** The shape whisper-cli writes with `-oj` (`-output-json`). */
interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number };
    text?: string;
  }>;
}

/**
 * Transcribe an audio file with whisper.cpp and return timed caption cues.
 * The audio should already be a format whisper accepts (wav/mp3/flac/ogg);
 * callers that need an exact range/sample-rate extract a 16 kHz mono WAV first.
 */
export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptCue[]> {
  const { bin, model } = await ensureWhisper(opts.model ?? DEFAULT_MODEL);

  const work = await mkdtemp(join(tmpdir(), "aive-whisper-"));
  const outPrefix = join(work, "out");
  try {
    const args = [
      "-m",
      model,
      "-f",
      audioPath,
      "-oj", // write out.json
      "-of",
      outPrefix,
      "-ml",
      String(opts.maxLen ?? 32),
      "-sow", // split on word, not mid-token
      "-np", // no progress prints to stdout
    ];
    if (opts.language) args.push("-l", opts.language);
    else args.push("-l", "en");
    if (opts.threads) args.push("-t", String(opts.threads));

    await execa(bin, args, { reject: true });

    const raw = await readFile(`${outPrefix}.json`, "utf8");
    const data = JSON.parse(raw) as WhisperJson;
    const cues: TranscriptCue[] = [];
    for (const seg of data.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      if (!text) continue;
      const start = (seg.offsets?.from ?? 0) / 1000;
      const end = (seg.offsets?.to ?? 0) / 1000;
      if (end <= start) continue;
      cues.push({ start, end, text });
    }
    return cues;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
