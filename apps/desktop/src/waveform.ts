// Renderer-side audio waveform peaks for the timeline. We decode an asset's
// audio once via WebAudio, downsample it to a compact peak array (0..1), and
// cache it by URL. Audio clips draw their slice of these peaks; the per-track
// level meter reads the peak at the playhead. No core/FFmpeg involvement — this
// is purely a renderer convenience (MIT, offline).

import { useEffect, useState } from "react";

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return ctx;
}

const DEFAULT_BUCKETS = 1600;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();
const failed = new Set<string>();

/** Downsample a decoded buffer to `buckets` max-abs peaks in [0,1]. */
function toPeaks(buf: AudioBuffer, buckets: number): Float32Array {
  const ch = buf.getChannelData(0);
  const n = ch.length;
  const out = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(n / buckets));
  let max = 1e-6;
  for (let i = 0; i < buckets; i++) {
    const start = i * size;
    const end = Math.min(n, start + size);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch[j]);
      if (a > peak) peak = a;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize so quiet sources still show a readable shape.
  const norm = max > 0 ? 1 / max : 1;
  for (let i = 0; i < buckets; i++) out[i] = Math.min(1, out[i] * norm);
  return out;
}

/** Decode + cache an asset's peaks. Returns null if the audio can't be decoded. */
export async function loadPeaks(url: string, buckets = DEFAULT_BUCKETS): Promise<Float32Array | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  if (failed.has(url)) return null;
  const pending = inflight.get(url);
  if (pending) return pending;

  const job = (async () => {
    try {
      const res = await fetch(url);
      const raw = await res.arrayBuffer();
      const buf = await audioCtx().decodeAudioData(raw);
      const peaks = toPeaks(buf, buckets);
      cache.set(url, peaks);
      return peaks;
    } catch {
      // Some video containers won't decode through WebAudio — that's fine, the
      // clip just renders without a waveform.
      failed.add(url);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, job);
  return job;
}

/** React hook: returns an asset's peaks once decoded (cached across clips). */
export function usePeaks(url?: string): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(() => (url ? cache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    const cached = cache.get(url);
    if (cached) { setPeaks(cached); return; }
    let alive = true;
    void loadPeaks(url).then((p) => { if (alive) setPeaks(p); });
    return () => { alive = false; };
  }, [url]);
  return peaks;
}

/** Max peak (0..1) over a fractional sub-range [a,b] of a peak array. */
export function peakRange(peaks: Float32Array, a: number, b: number): number {
  const lo = Math.max(0, Math.min(1, Math.min(a, b)));
  const hi = Math.max(0, Math.min(1, Math.max(a, b)));
  const i0 = Math.floor(lo * (peaks.length - 1));
  const i1 = Math.max(i0, Math.floor(hi * (peaks.length - 1)));
  let m = 0;
  for (let i = i0; i <= i1; i++) if (peaks[i] > m) m = peaks[i];
  return m;
}
