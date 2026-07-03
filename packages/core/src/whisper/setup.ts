import { mkdir, access, rm, readdir, copyFile, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { execa } from "execa";

/**
 * Local setup for whisper.cpp (MIT). On first use we download a prebuilt
 * `whisper-cli` binary and a ggml model, cache them under
 * `~/.aive/whisper` (override with AIVE_WHISPER_DIR), and reuse them forever
 * after. Everything stays on the machine — transcription is fully offline.
 *
 * Both pieces can be pointed at pre-installed copies via env vars, which is how
 * packaged desktop builds (and CI) skip the download:
 *   - AIVE_WHISPER_BIN    absolute path to a whisper-cli executable
 *   - AIVE_WHISPER_MODEL  absolute path to a ggml-*.bin model file
 */

/** The whisper.cpp release we pin prebuilt binaries to. */
const WHISPER_RELEASE = "v1.9.0";

/** Models we know how to fetch, by short name. base.en is a good default. */
export const WHISPER_MODELS = [
  "tiny.en",
  "tiny",
  "base.en",
  "base",
  "small.en",
  "small",
  "medium.en",
  "medium",
  "large-v3-turbo",
] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export const DEFAULT_MODEL: WhisperModel = "base.en";

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface WhisperPaths {
  /** Absolute path to the whisper-cli executable. */
  bin: string;
  /** Absolute path to the ggml model file. */
  model: string;
}

function cacheRoot(): string {
  return process.env.AIVE_WHISPER_DIR || join(homedir(), ".aive", "whisper");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Stream a URL to a file, following redirects (Hugging Face / GitHub CDNs). */
async function download(url: string, dest: string, label: string): Promise<void> {
  process.stderr.write(`[whisper] downloading ${label} …\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${label} (${res.status} ${res.statusText}) from ${url}`);
  }
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  // Atomic-ish rename so a half-written file is never mistaken for complete.
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  process.stderr.write(`[whisper] saved ${label}\n`);
}

/** Extract a .zip or .tar.gz using the system `tar` (bsdtar handles both). */
async function extract(archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await execa("tar", ["-xf", archive, "-C", destDir]);
}

/** Recursively find the first file matching `name` under `dir`. */
async function findFile(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/** The prebuilt CLI archive asset name for the current platform, or null. */
function binaryAsset(): { asset: string; exe: string } | null {
  const p = platform();
  const a = arch();
  if (p === "win32" && a === "x64") return { asset: "whisper-bin-x64.zip", exe: "whisper-cli.exe" };
  if (p === "linux" && a === "x64") return { asset: "whisper-bin-ubuntu-x64.tar.gz", exe: "whisper-cli" };
  if (p === "linux" && a === "arm64") return { asset: "whisper-bin-ubuntu-arm64.tar.gz", exe: "whisper-cli" };
  // macOS ships only an xcframework in releases — require a pre-installed binary.
  return null;
}

/** Ensure a whisper-cli binary is available; download+extract if missing. */
async function ensureBinary(): Promise<string> {
  if (process.env.AIVE_WHISPER_BIN) {
    if (!(await exists(process.env.AIVE_WHISPER_BIN))) {
      throw new Error(`AIVE_WHISPER_BIN points at a missing file: ${process.env.AIVE_WHISPER_BIN}`);
    }
    return process.env.AIVE_WHISPER_BIN;
  }

  const spec = binaryAsset();
  if (!spec) {
    throw new Error(
      `No prebuilt whisper.cpp binary is published for ${platform()}/${arch()}. ` +
        `Install whisper.cpp yourself (e.g. 'brew install whisper-cpp') and set AIVE_WHISPER_BIN ` +
        `to the whisper-cli path.`,
    );
  }

  const binDir = join(cacheRoot(), "bin");
  const cached = join(binDir, spec.exe);
  if (await exists(cached)) return cached;

  await mkdir(binDir, { recursive: true });
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${spec.asset}`;
  const archive = join(binDir, spec.asset);
  await download(url, archive, `whisper.cpp ${WHISPER_RELEASE} (${spec.asset})`);

  const stageDir = join(binDir, "_extract");
  await rm(stageDir, { recursive: true, force: true });
  await extract(archive, stageDir);

  // The prebuilt archives keep whisper-cli alongside the shared libraries it
  // links against (whisper.dll/.so, ggml*.dll/.so). Flatten everything that
  // sits next to the exe into binDir so it can run from there.
  const exePath = await findFile(stageDir, spec.exe);
  if (!exePath) throw new Error(`Could not find ${spec.exe} inside ${spec.asset}`);
  const { dirname } = await import("node:path");
  const exeDir = dirname(exePath);
  for (const entry of await readdir(exeDir, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(join(exeDir, entry.name), join(binDir, entry.name));
  }
  await rm(stageDir, { recursive: true, force: true });
  await rm(archive, { force: true });
  if (platform() !== "win32") await chmod(cached, 0o755);
  return cached;
}

/** Ensure the requested ggml model is available; download if missing. */
async function ensureModel(model: WhisperModel): Promise<string> {
  if (process.env.AIVE_WHISPER_MODEL) {
    if (!(await exists(process.env.AIVE_WHISPER_MODEL))) {
      throw new Error(`AIVE_WHISPER_MODEL points at a missing file: ${process.env.AIVE_WHISPER_MODEL}`);
    }
    return process.env.AIVE_WHISPER_MODEL;
  }

  const file = `ggml-${model}.bin`;
  const modelsDir = join(cacheRoot(), "models");
  const cached = join(modelsDir, file);
  if (await exists(cached)) return cached;

  await mkdir(modelsDir, { recursive: true });
  await download(`${MODEL_BASE_URL}/${file}`, cached, `model ${model}`);
  return cached;
}

/**
 * Ensure whisper.cpp and the requested model are present locally, downloading
 * either on first use. Returns absolute paths to both. Safe to call repeatedly;
 * it only downloads what's missing.
 */
export async function ensureWhisper(model: WhisperModel = DEFAULT_MODEL): Promise<WhisperPaths> {
  // Run sequentially so the first-run download logs are readable (and to avoid
  // hammering two CDNs at once on a slow link).
  const bin = await ensureBinary();
  const modelPath = await ensureModel(model);
  return { bin, model: modelPath };
}
