import { mkdir, access, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Local setup for the semantic-search model: a SMALL, permissively-licensed
 * CLIP (OpenAI CLIP ViT-B/32 is MIT). We use the ONNX export + tokenizer files
 * (quantized, ~tens of MB) so it runs on CPU via onnxruntime — no GPU, no crash
 * risk. Downloaded ONCE on first use and cached under ~/.aive/clip (override
 * with AIVE_CLIP_DIR), then reused offline forever. If the files aren't present
 * and can't be fetched, callers gracefully fall back to perceptual search.
 *
 * Everything is overridable so packaged builds / air-gapped installs can ship
 * the files instead of downloading:
 *   - AIVE_CLIP_DIR      cache directory (defaults to ~/.aive/clip)
 *   - AIVE_CLIP_URL      base URL to fetch the four files from
 *   - AIVE_CLIP_DISABLE  set to "1" to force-disable semantic search
 * Individual file names can be overridden with AIVE_CLIP_{VISION,TEXT,MERGES,VOCAB}.
 */

export interface ClipModelPack {
  /** ONNX image encoder (input pixel_values [1,3,224,224] → image_embeds). */
  visionOnnx: string;
  /** ONNX text encoder (input input_ids/attention_mask [1,77] → text_embeds). */
  textOnnx: string;
  /** BPE merges file (merges.txt). */
  merges: string;
  /** Token→id vocabulary (vocab.json). */
  vocab: string;
}

// Default source: a permissive (MIT CLIP) ONNX repackage. Quantized to stay small.
const DEFAULT_BASE = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main";
const REMOTE = {
  visionOnnx: process.env.AIVE_CLIP_VISION_REMOTE || "onnx/vision_model_quantized.onnx",
  textOnnx: process.env.AIVE_CLIP_TEXT_REMOTE || "onnx/text_model_quantized.onnx",
  merges: process.env.AIVE_CLIP_MERGES_REMOTE || "merges.txt",
  vocab: process.env.AIVE_CLIP_VOCAB_REMOTE || "vocab.json",
};
const LOCAL = { visionOnnx: "vision.onnx", textOnnx: "text.onnx", merges: "merges.txt", vocab: "vocab.json" };

function cacheRoot(): string {
  return process.env.AIVE_CLIP_DIR || join(homedir(), ".aive", "clip");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function localPaths(): ClipModelPack {
  const dir = cacheRoot();
  return {
    visionOnnx: process.env.AIVE_CLIP_VISION || join(dir, LOCAL.visionOnnx),
    textOnnx: process.env.AIVE_CLIP_TEXT || join(dir, LOCAL.textOnnx),
    merges: process.env.AIVE_CLIP_MERGES || join(dir, LOCAL.merges),
    vocab: process.env.AIVE_CLIP_VOCAB || join(dir, LOCAL.vocab),
  };
}

/** True only if all four files are ALREADY on disk (never triggers a download). */
export async function isClipReady(): Promise<boolean> {
  if (process.env.AIVE_CLIP_DISABLE === "1") return false;
  const p = localPaths();
  const checks = await Promise.all([exists(p.visionOnnx), exists(p.textOnnx), exists(p.merges), exists(p.vocab)]);
  return checks.every(Boolean);
}

/** Resolved paths if ready, else null. Synchronous-ish convenience for callers. */
export async function clipPackIfReady(): Promise<ClipModelPack | null> {
  return (await isClipReady()) ? localPaths() : null;
}

async function download(url: string, dest: string): Promise<void> {
  process.stderr.write(`[clip] downloading ${url.split("/").pop()} …\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  await rename(tmp, dest);
}

/**
 * Ensure the CLIP model pack is present, downloading the four files ONCE if
 * missing. Returns the resolved paths, or NULL when semantic search is disabled
 * or the files can't be fetched (caller falls back to perceptual). Never throws.
 */
export async function ensureClipModel(): Promise<ClipModelPack | null> {
  if (process.env.AIVE_CLIP_DISABLE === "1") return null;
  const pack = localPaths();
  if (await isClipReady()) return pack;

  // If the user pointed env at explicit files but they're missing, don't try to
  // download (they intended a manual install) — just report unavailable.
  if (process.env.AIVE_CLIP_VISION || process.env.AIVE_CLIP_TEXT) return null;

  try {
    const base = process.env.AIVE_CLIP_URL || DEFAULT_BASE;
    await mkdir(cacheRoot(), { recursive: true });
    // Sequential downloads keep first-run logs readable and the link unsaturated.
    if (!(await exists(pack.visionOnnx))) await download(`${base}/${REMOTE.visionOnnx}`, pack.visionOnnx);
    if (!(await exists(pack.textOnnx))) await download(`${base}/${REMOTE.textOnnx}`, pack.textOnnx);
    if (!(await exists(pack.merges))) await download(`${base}/${REMOTE.merges}`, pack.merges);
    if (!(await exists(pack.vocab))) await download(`${base}/${REMOTE.vocab}`, pack.vocab);
    return (await isClipReady()) ? pack : null;
  } catch (err) {
    process.stderr.write(`[clip] semantic model unavailable (${(err as Error).message}); using perceptual search\n`);
    return null;
  }
}
