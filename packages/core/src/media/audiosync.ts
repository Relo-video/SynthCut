import { runFfmpegStdoutBuffer } from "../ffmpeg/executor.js";

/**
 * Align two takes by SOUND, fully locally. We extract a coarse loudness
 * envelope from each clip's audio (mono, 8 kHz → 100 Hz RMS frames) and
 * cross-correlate the envelopes over a bounded lag window. Envelope
 * cross-correlation is robust to level/EQ differences and cheap enough to do in
 * plain TypeScript (no FFT needed at 100 Hz). Pure FFmpeg + arithmetic.
 */

const SR = 8000; // analysis sample rate
const ENV_HOP = 80; // 80 samples per envelope frame → 100 Hz envelope
const ENV_HZ = SR / ENV_HOP;

/** Extract a mono s16le PCM buffer (8 kHz) for the first `seconds` of audio. */
async function extractPcm(path: string, seconds: number): Promise<Int16Array> {
  const buf = await runFfmpegStdoutBuffer([
    "-hide_banner",
    "-t",
    seconds.toFixed(3),
    "-i",
    path,
    "-ac",
    "1",
    "-ar",
    String(SR),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-",
  ]);
  // Int16 view over the raw little-endian bytes.
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** RMS loudness envelope at 100 Hz, then z-normalized (mean 0, unit variance). */
function envelope(pcm: Int16Array): Float64Array {
  const frames = Math.floor(pcm.length / ENV_HOP);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * ENV_HOP;
    for (let i = 0; i < ENV_HOP; i++) {
      const s = pcm[base + i] / 32768;
      sum += s * s;
    }
    env[f] = Math.sqrt(sum / ENV_HOP);
  }
  // z-normalize so correlation is amplitude-independent.
  let mean = 0;
  for (let i = 0; i < frames; i++) mean += env[i];
  mean /= frames || 1;
  let varc = 0;
  for (let i = 0; i < frames; i++) {
    env[i] -= mean;
    varc += env[i] * env[i];
  }
  const std = Math.sqrt(varc / (frames || 1)) || 1;
  for (let i = 0; i < frames; i++) env[i] /= std;
  return env;
}

export interface AudioSyncResult {
  /**
   * Seconds the `clip` audio LAGS the `reference` audio. Positive = clip's
   * sound happens later than the reference (shift clip earlier to align);
   * negative = clip leads. Apply as a clip move or audio offset.
   */
  offsetSeconds: number;
  /** Normalized peak correlation (−1..1); higher = more confident. */
  confidence: number;
}

/**
 * Find the time offset that best aligns `clipPath` to `refPath` by sound.
 *
 * @param maxLagSeconds  Search ± this many seconds (default 15).
 * @param analyzeSeconds Analyze at most this many seconds of each (default 45).
 */
export async function findAudioOffset(
  refPath: string,
  clipPath: string,
  maxLagSeconds = 15,
  analyzeSeconds = 45,
): Promise<AudioSyncResult> {
  const [refPcm, clipPcm] = await Promise.all([
    extractPcm(refPath, analyzeSeconds),
    extractPcm(clipPath, analyzeSeconds),
  ]);
  if (refPcm.length === 0 || clipPcm.length === 0) {
    throw new Error("audio-sync: one of the clips has no decodable audio");
  }
  const a = envelope(refPcm); // reference (zero-mean, unit-variance)
  const b = envelope(clipPcm); // clip
  const maxLag = Math.round(maxLagSeconds * ENV_HZ);
  // Require a substantial overlap so a few aligned edge frames can't win — this
  // is what kills spurious peaks at large lags.
  const minOverlap = Math.max(ENV_HZ, Math.floor(0.5 * Math.min(a.length, b.length)));

  let bestLag = 0;
  let bestScore = -Infinity;
  // lag > 0 means b (clip) is delayed relative to a (reference). For each lag we
  // compute a proper normalized cross-correlation over the OVERLAP (Pearson on
  // the overlapping segments), so the score is comparable across lags.
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const start = Math.max(0, lag);
    const end = Math.min(a.length, b.length + lag);
    const count = end - start;
    if (count < minOverlap) continue;
    let dot = 0;
    let sa = 0;
    let sb = 0;
    for (let i = start; i < end; i++) {
      const av = a[i];
      const bv = b[i - lag];
      dot += av * bv;
      sa += av * av;
      sb += bv * bv;
    }
    const denom = Math.sqrt(sa * sb);
    if (denom <= 1e-9) continue;
    const score = dot / denom; // −1..1
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Convention: positive offset = the CLIP lags the reference (its sound happens
  // later). In the loop, a[i] aligns with b[i−lag], so a positive bestLag means
  // the clip is AHEAD of the reference; negate to make "later = positive".
  return {
    offsetSeconds: -bestLag / ENV_HZ,
    confidence: Number.isFinite(bestScore) ? Math.max(-1, Math.min(1, bestScore)) : 0,
  };
}
