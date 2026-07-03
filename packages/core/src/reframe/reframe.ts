import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { FFMPEG_BIN } from "../ffmpeg/executor.js";
import { FaceDetector } from "./detector.js";

/**
 * Subject tracking for auto-reframe. We sample frames from a clip, run YuNet
 * face detection on each, and produce a smoothed path of the subject's centre
 * (in source pixels) over time. The engine turns that path into a moving crop
 * window so a person stays in frame when reframing (e.g. 16:9 → 9:16).
 */

const DET = FaceDetector.inputSize; // 640

export interface TrackSample {
  /** Seconds from the clip's start. */
  t: number;
  /** Subject centre in source pixels (NaN when no face was found). */
  cx: number;
  cy: number;
  found: boolean;
}

export interface TrackResult {
  samples: TrackSample[];
  /** Fraction of sampled frames in which a face was detected (0..1). */
  hitRate: number;
}

/** How a source frame is letterboxed into the square detector input. */
function letterbox(srcW: number, srcH: number) {
  const r = Math.min(DET / srcW, DET / srcH);
  const sw = Math.round(srcW * r);
  const sh = Math.round(srcH * r);
  const px = Math.floor((DET - sw) / 2);
  const py = Math.floor((DET - sh) / 2);
  return { r, sw, sh, px, py };
}

export interface TrackOptions {
  path: string;
  sourceIn: number;
  span: number;
  srcW: number;
  srcH: number;
  /** Frames per second to sample for detection. Default 4. */
  sampleFps?: number;
  /** Cap on total sampled frames (keeps memory/disk bounded). Default 480. */
  maxFrames?: number;
  scoreThreshold?: number;
}

/**
 * Sample a clip and track the dominant subject's centre over time. Picks, per
 * frame, the highest-scoring face (ties broken by area), and maps its centre
 * back to source pixels. Frames with no detection are marked `found: false`
 * for the caller to interpolate over.
 */
export async function trackSubject(opts: TrackOptions): Promise<TrackResult> {
  const requested = opts.sampleFps ?? 4;
  const maxFrames = opts.maxFrames ?? 480;
  // Lower the sample rate for long clips so we never exceed maxFrames.
  const fps = Math.min(requested, Math.max(0.5, maxFrames / Math.max(opts.span, 0.001)));
  const { r, sw, sh, px, py } = letterbox(opts.srcW, opts.srcH);

  const work = await mkdtemp(join(tmpdir(), "aive-reframe-"));
  const rawPath = join(work, "frames.rgb");
  try {
    await execa(
      FFMPEG_BIN,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        opts.sourceIn.toFixed(6),
        "-t",
        opts.span.toFixed(6),
        "-i",
        opts.path,
        "-vf",
        `fps=${fps.toFixed(6)},scale=${sw}:${sh},pad=${DET}:${DET}:${px}:${py}:color=black,format=rgb24`,
        "-f",
        "rawvideo",
        "-y",
        rawPath,
      ],
      { reject: true },
    );

    const detector = await FaceDetector.create();
    const frameBytes = DET * DET * 3;
    const buf = Buffer.alloc(frameBytes);
    const fh = await open(rawPath, "r");
    const samples: TrackSample[] = [];
    let hits = 0;
    try {
      let i = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, frameBytes, null);
        if (bytesRead < frameBytes) break; // last partial/empty chunk
        const faces = await detector.detect(buf, opts.scoreThreshold ?? 0.6);
        const t = i / fps;
        if (faces.length === 0) {
          samples.push({ t, cx: NaN, cy: NaN, found: false });
        } else {
          // Highest score; ties to the largest box.
          const best = faces.reduce((a, b) =>
            b.score > a.score + 1e-3 || (Math.abs(b.score - a.score) <= 1e-3 && b.w * b.h > a.w * a.h) ? b : a,
          );
          const detCx = best.x + best.w / 2;
          const detCy = best.y + best.h / 2;
          const cx = Math.min(opts.srcW, Math.max(0, (detCx - px) / r));
          const cy = Math.min(opts.srcH, Math.max(0, (detCy - py) / r));
          samples.push({ t, cx, cy, found: true });
          hits++;
        }
        i++;
      }
    } finally {
      await fh.close();
    }

    return { samples, hitRate: samples.length ? hits / samples.length : 0 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface CropKey {
  t: number;
  x: number;
  y: number;
}

export interface CropPlanOptions {
  srcW: number;
  srcH: number;
  cropW: number;
  cropH: number;
  /** EMA smoothing factor 0..1 (lower = smoother/laggier). Default 0.25. */
  smoothing?: number;
}

/**
 * Turn tracked subject centres into a smoothed, bounded sequence of crop-window
 * top-left positions. Gaps (frames with no detection) are filled by holding the
 * last known centre; the path is then exponentially smoothed and clamped inside
 * the source frame. Redundant keys (no movement) are dropped.
 */
export function buildCropPlan(samples: TrackSample[], opts: CropPlanOptions): CropKey[] {
  const { srcW, srcH, cropW, cropH } = opts;
  const alpha = opts.smoothing ?? 0.25;
  const maxX = Math.max(0, srcW - cropW);
  const maxY = Math.max(0, srcH - cropH);

  // Fill missing centres: forward-fill, then back-fill the leading gap.
  const cx: number[] = new Array(samples.length);
  const cy: number[] = new Array(samples.length);
  let lastX = NaN;
  let lastY = NaN;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].found) {
      lastX = samples[i].cx;
      lastY = samples[i].cy;
    }
    cx[i] = lastX;
    cy[i] = lastY;
  }
  // Leading gap (no detection yet): default to centre, then back-fill.
  const firstKnownX = cx.find((v) => !Number.isNaN(v));
  const firstKnownY = cy.find((v) => !Number.isNaN(v));
  const seedX = firstKnownX ?? srcW / 2;
  const seedY = firstKnownY ?? srcH / 2;
  for (let i = 0; i < samples.length; i++) {
    if (Number.isNaN(cx[i])) cx[i] = seedX;
    if (Number.isNaN(cy[i])) cy[i] = seedY;
  }

  // Exponential smoothing of the centre path.
  const keys: CropKey[] = [];
  let emaX = cx[0] ?? srcW / 2;
  let emaY = cy[0] ?? srcH / 2;
  let prevX = -1;
  let prevY = -1;
  for (let i = 0; i < samples.length; i++) {
    emaX = alpha * cx[i] + (1 - alpha) * emaX;
    emaY = alpha * cy[i] + (1 - alpha) * emaY;
    const x = Math.round(Math.min(maxX, Math.max(0, emaX - cropW / 2)));
    const y = Math.round(Math.min(maxY, Math.max(0, emaY - cropH / 2)));
    // Drop keys that don't move the window (but always keep the first).
    if (keys.length === 0 || x !== prevX || y !== prevY) {
      keys.push({ t: samples[i].t, x, y });
      prevX = x;
      prevY = y;
    }
  }
  if (keys.length === 0) keys.push({ t: 0, x: Math.round(maxX / 2), y: Math.round(maxY / 2) });
  return keys;
}

/** Serialize a crop plan into an FFmpeg `sendcmd` script (crop x/y over time). */
export function cropPlanToSendcmd(keys: CropKey[]): string {
  const lines: string[] = [];
  for (const k of keys) {
    lines.push(`${k.t.toFixed(3)} crop x ${k.x};`);
    lines.push(`${k.t.toFixed(3)} crop y ${k.y};`);
  }
  return lines.join("\n") + "\n";
}
