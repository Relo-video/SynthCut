import { runFfmpegStdoutBuffer } from "../ffmpeg/executor.js";
import { ensureClipModel, isClipReady, type ClipModelPack } from "./clipModel.js";
import { ClipTokenizer } from "./clipTokenizer.js";

/**
 * Semantic visual search via a small, local CLIP model (OpenAI CLIP ViT-B/32,
 * MIT) running on CPU through onnxruntime. Two encoders share one embedding
 * space, so an IMAGE frame and a TEXT query become comparable vectors:
 *   - embedImage → index shots by appearance/meaning
 *   - embedText  → "find the wide shot of the sunset" (text → image)
 * Cosine similarity ranks them. The model pack (vision/text ONNX + tokenizer) is
 * downloaded once and cached (see clipModel.ts); if it's unavailable, callers
 * fall back to the always-on perceptual fingerprint — the editor never blocks.
 */

const SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

interface Loaded {
  pack: ClipModelPack;
  vision: OrtSession;
  text: OrtSession;
  tok: ClipTokenizer;
}
interface OrtSession {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: ArrayLike<number> }>>;
  inputNames: string[];
  outputNames: string[];
}

let loadPromise: Promise<Loaded | null> | null = null;

/** True if the model is already on disk (no download). Cheap pre-check. */
export async function isClipAvailable(): Promise<boolean> {
  return isClipReady();
}

/** Load (and cache) the sessions + tokenizer, downloading the pack once if needed. */
async function load(): Promise<Loaded | null> {
  if (!loadPromise) {
    loadPromise = (async (): Promise<Loaded | null> => {
      const pack = await ensureClipModel();
      if (!pack) return null;
      try {
        const ort = await import("onnxruntime-node");
        const [vision, text] = await Promise.all([
          ort.InferenceSession.create(pack.visionOnnx),
          ort.InferenceSession.create(pack.textOnnx),
        ]);
        const tok = await ClipTokenizer.load(pack.vocab, pack.merges);
        return { pack, vision: vision as unknown as OrtSession, text: text as unknown as OrtSession, tok };
      } catch (err) {
        process.stderr.write(`[clip] failed to load model (${(err as Error).message}); using perceptual\n`);
        return null;
      }
    })();
  }
  return loadPromise;
}

/** Ensure the model is fetched/loaded; returns true if semantic search is usable. */
export async function ensureClip(): Promise<boolean> {
  return (await load()) !== null;
}

function l2normalize(data: ArrayLike<number>): number[] {
  let norm = 0;
  for (let i = 0; i < data.length; i++) norm += data[i] * data[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / norm;
  return out;
}

async function grab224(path: string, t: number): Promise<Buffer> {
  return runFfmpegStdoutBuffer([
    "-hide_banner", "-ss", Math.max(0, t).toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", `scale=${SIZE}:${SIZE}`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
}

/** Embed one frame of `path` at time `t`, or null if the model isn't available. */
export async function embedImage(path: string, t: number): Promise<number[] | null> {
  const m = await load();
  if (!m) return null;
  const buf = await grab224(path, t);
  if (buf.length < SIZE * SIZE * 3) return null;

  const chw = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) chw[c * plane + p] = (buf[p * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const ort = await import("onnxruntime-node");
  const tensor = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const feeds: Record<string, unknown> = { [m.vision.inputNames[0]]: tensor };
  const out = await m.vision.run(feeds);
  const name = m.vision.outputNames.find((n) => /embed/i.test(n)) ?? m.vision.outputNames[0];
  return l2normalize(out[name].data);
}

/** Embed a free-text query into the shared CLIP space, or null if unavailable. */
export async function embedText(query: string): Promise<number[] | null> {
  const m = await load();
  if (!m) return null;
  const { ids, mask } = m.tok.encode(query);
  const ort = await import("onnxruntime-node");
  const idsT = new ort.Tensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]);
  const maskT = new ort.Tensor("int64", BigInt64Array.from(mask.map((n) => BigInt(n))), [1, mask.length]);
  const feeds: Record<string, unknown> = {};
  for (const inName of m.text.inputNames) {
    if (/mask/i.test(inName)) feeds[inName] = maskT;
    else feeds[inName] = idsT;
  }
  const out = await m.text.run(feeds);
  const name = m.text.outputNames.find((n) => /embed/i.test(n)) ?? m.text.outputNames[0];
  return l2normalize(out[name].data);
}

/** Cosine similarity of two unit-normalized vectors (returns 0 on mismatch). */
export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
