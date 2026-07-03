import { runFfmpegStdoutBuffer } from "../ffmpeg/executor.js";
import type { VisualSample, VisualSignature } from "../types.js";

/**
 * Fully-local perceptual visual fingerprinting — "find shots that look like
 * this" without any ML model. For a handful of sampled keyframes we compute an
 * 8×8 difference hash (structure) and a small RGB histogram (color). Matching is
 * a Hamming distance on the hashes blended with a histogram intersection.
 *
 * Pure FFmpeg + arithmetic: no new dependencies, no network, MIT-clean.
 */

const BINS = 8; // histogram bins per channel → hist length = 24

/** Extract a 9×8 RGB frame at time `t` (seconds) as raw rgb24 (216 bytes). */
async function grab9x8(path: string, t: number): Promise<Buffer> {
  // 9 wide × 8 tall: the extra column yields 8 horizontal diffs per row (= dHash).
  return runFfmpegStdoutBuffer([
    "-hide_banner",
    "-ss",
    Math.max(0, t).toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "scale=9:8:flags=area",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Compute the {dhash, hist} fingerprint of one 9×8 rgb24 buffer. */
function fingerprint(buf: Buffer): { dhash: string; hist: number[] } {
  const W = 9;
  const H = 8;
  // dHash: for each of the 8 rows, compare each pixel to its right neighbor.
  let bits = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = (y * W + x) * 3;
      const j = (y * W + x + 1) * 3;
      const left = lum(buf[i], buf[i + 1], buf[i + 2]);
      const right = lum(buf[j], buf[j + 1], buf[j + 2]);
      bits += left > right ? "1" : "0";
    }
  }
  // 64 bits → 16 hex chars.
  let dhash = "";
  for (let k = 0; k < 64; k += 4) dhash += parseInt(bits.slice(k, k + 4), 2).toString(16);

  // Color histogram over all 72 pixels.
  const hist = new Array(BINS * 3).fill(0);
  const px = W * H;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const rb = Math.min(BINS - 1, (buf[i] * BINS) >> 8);
    const gb = Math.min(BINS - 1, (buf[i + 1] * BINS) >> 8);
    const bb = Math.min(BINS - 1, (buf[i + 2] * BINS) >> 8);
    hist[rb] += 1;
    hist[BINS + gb] += 1;
    hist[BINS * 2 + bb] += 1;
  }
  // Normalize each channel block to sum 1.
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let b = 0; b < BINS; b++) s += hist[c * BINS + b];
    if (s > 0) for (let b = 0; b < BINS; b++) hist[c * BINS + b] /= s;
  }
  return { dhash, hist };
}

/** Hamming distance (0..64) between two 16-hex-char dHashes. */
export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = (parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16)) & 0xf;
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Histogram intersection similarity (0..1; 1 = identical). */
export function histSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  // Each of the 3 channel blocks sums to 1, so total intersection is 0..3.
  let inter = 0;
  for (let i = 0; i < n; i++) inter += Math.min(a[i], b[i]);
  return inter / 3;
}

/**
 * Blended similarity between two visual samples (0..1). Structure (dHash) is
 * weighted a bit more than color, since color alone matches too loosely.
 */
export function sampleSimilarity(a: VisualSample, b: VisualSample): number {
  const structure = 1 - hashDistance(a.dhash, b.dhash) / 64;
  const color = histSimilarity(a.hist, b.hist);
  let s = 0.6 * structure + 0.4 * color;
  // If both carry CLIP embeddings, fold in semantic cosine similarity.
  if (a.embed && b.embed && a.embed.length === b.embed.length) {
    let dot = 0;
    for (let i = 0; i < a.embed.length; i++) dot += a.embed[i] * b.embed[i];
    s = 0.5 * ((dot + 1) / 2) + 0.5 * s;
  }
  return s;
}

/** Best-matching similarity between two whole signatures (max over sample pairs). */
export function signatureSimilarity(a: VisualSignature, b: VisualSignature): number {
  let best = 0;
  for (const sa of a.samples) {
    for (const sb of b.samples) {
      const s = sampleSimilarity(sa, sb);
      if (s > best) best = s;
    }
  }
  return best;
}

/**
 * Build a perceptual signature for an asset by sampling `count` evenly-spaced
 * keyframes across `duration` seconds.
 */
export async function buildSignature(path: string, duration: number, count = 5): Promise<VisualSignature> {
  const n = Math.max(1, Math.min(count, 12));
  const samples: VisualSample[] = [];
  for (let k = 0; k < n; k++) {
    // Sample at the midpoints of n equal segments (avoids the very first/last frame).
    const t = duration > 0 ? ((k + 0.5) / n) * duration : 0;
    try {
      const buf = await grab9x8(path, t);
      if (buf.length >= 9 * 8 * 3) {
        const fp = fingerprint(buf);
        samples.push({ t, dhash: fp.dhash, hist: fp.hist });
      }
    } catch {
      // Skip a sample that won't decode; keep whatever we got.
    }
  }
  return { samples, bins: BINS };
}

/** Build a single-sample signature from one reference frame at time `t`. */
export async function buildReferenceSample(path: string, t: number): Promise<VisualSample> {
  const buf = await grab9x8(path, t);
  const fp = fingerprint(buf);
  return { t, dhash: fp.dhash, hist: fp.hist };
}
