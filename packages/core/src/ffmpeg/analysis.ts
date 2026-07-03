import { join } from "node:path";
import { runFfmpeg, runFfmpegCaptureStderr, runFfmpegStdoutBuffer } from "./executor.js";

/**
 * Analysis helpers that give the AI "ears and eyes" so it can edit with intent
 * instead of cutting blindly. These are pure FFmpeg signal-processing filters —
 * no ML models, no licensing concerns, fully local.
 */

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

/**
 * Detect silent ranges in a media file using FFmpeg's `silencedetect` filter.
 * Useful for trimming dead air from talking-head footage and finding natural
 * sentence boundaries to cut on.
 *
 * @param noiseDb   Threshold below which audio counts as silence (e.g. -30).
 * @param minDur    Minimum silence length to report, in seconds.
 */
export async function detectSilence(
  path: string,
  noiseDb = -30,
  minDur = 0.5,
): Promise<SilenceRange[]> {
  const stderr = await runFfmpegCaptureStderr([
    "-hide_banner",
    "-i",
    path,
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    "-f",
    "null",
    "-",
  ]);

  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && pendingStart !== null) {
      const end = Number(endMatch[1]);
      ranges.push({ start: pendingStart, end, duration: Number(endMatch[2]) });
      pendingStart = null;
    }
  }

  return ranges;
}

export interface SceneCut {
  /** Timestamp in seconds where a scene change was detected. */
  time: number;
}

/**
 * Detect scene-change timestamps using FFmpeg's `select='gt(scene,...)'` filter.
 * Useful for finding natural cut points in continuous footage.
 *
 * @param threshold  Scene-change sensitivity 0..1 (higher = fewer cuts).
 */
export async function detectScenes(path: string, threshold = 0.4): Promise<SceneCut[]> {
  const stderr = await runFfmpegCaptureStderr([
    "-hide_banner",
    "-i",
    path,
    "-filter:v",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ]);

  const cuts: SceneCut[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/pts_time:([0-9.]+)/);
    if (m) cuts.push({ time: Number(m[1]) });
  }
  return cuts;
}

/** Numeric color readout of a single still frame (8-bit ranges). */
export interface ColorStats {
  /** Luma min/avg/max (0..255) and contrast (max−min). */
  luma: { min: number; avg: number; max: number; contrast: number };
  /** Saturation average/peak (0..~180). */
  saturation: { avg: number; max: number };
  /** Average hue angle in degrees (0..360). */
  hue: { avg: number };
  /** Mean R/G/B of the whole frame (0..255). */
  rgb: { r: number; g: number; b: number };
  /** A plain-language exposure/cast read for the AI to act on. */
  notes: string[];
}

/** Rendered scope visualizations (PNG paths) for the human/AI to view. */
export interface ScopeImages {
  histogram: string;
  waveform: string;
  vectorscope: string;
}

export interface ColorInspection {
  stats: ColorStats;
  scopes: ScopeImages;
}

/** Parse `lavfi.signalstats.KEY=value` lines into a lookup. */
function parseSignalStats(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/lavfi\.signalstats\.(\w+)=(-?[0-9.]+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * Inspect the color of a single still frame: numeric scopes via `signalstats`
 * plus the frame's mean RGB, and three rendered scope images (histogram,
 * waveform, vectorscope). Pure FFmpeg signal processing — local, no models.
 *
 * @param framePath  PNG/JPEG of the frame to measure.
 * @param scopeDir   Directory to write the scope PNGs into.
 * @param tag        Unique suffix for the scope filenames (avoids collisions).
 */
export async function inspectFrameColor(
  framePath: string,
  scopeDir: string,
  tag: string,
): Promise<ColorInspection> {
  // 1. Numeric stats. The metadata `print` filter logs each lavfi.signalstats.*
  //    key to stderr (same channel showinfo/silencedetect use).
  const statsErr = await runFfmpegCaptureStderr([
    "-hide_banner",
    "-i",
    framePath,
    "-vf",
    "signalstats,metadata=print",
    "-f",
    "null",
    "-",
  ]);
  const s = parseSignalStats(statsErr);

  // 2. Mean RGB = the single pixel of a 1×1 average-downscale, read raw.
  const rgbBuf = await runFfmpegStdoutBuffer([
    "-hide_banner",
    "-i",
    framePath,
    "-vf",
    "scale=1:1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  const rgb = {
    r: rgbBuf[0] ?? 0,
    g: rgbBuf[1] ?? 0,
    b: rgbBuf[2] ?? 0,
  };

  const luma = {
    min: s.YMIN ?? 0,
    avg: s.YAVG ?? 0,
    max: s.YMAX ?? 0,
    contrast: (s.YMAX ?? 0) - (s.YMIN ?? 0),
  };
  const saturation = { avg: s.SATAVG ?? 0, max: s.SATMAX ?? 0 };
  const hue = { avg: s.HUEAVG ?? s.HUEMED ?? 0 };

  const notes: string[] = [];
  if (luma.avg < 60) notes.push("dark/underexposed (low average luma)");
  else if (luma.avg > 200) notes.push("bright/overexposed (high average luma)");
  if (luma.contrast < 90) notes.push("low contrast (crushed dynamic range)");
  if (saturation.avg < 20) notes.push("near-monochrome / desaturated");
  else if (saturation.avg > 120) notes.push("very saturated");
  if (rgb.r - rgb.b > 25) notes.push("warm color cast (red > blue)");
  else if (rgb.b - rgb.r > 25) notes.push("cool color cast (blue > red)");
  if (!notes.length) notes.push("balanced exposure and color");

  // 3. Scope images.
  const scope = (name: string) => join(scopeDir, `scope-${tag}-${name}.png`);
  const histogram = scope("histogram");
  const waveform = scope("waveform");
  const vectorscope = scope("vectorscope");
  await Promise.all([
    runFfmpeg(["-hide_banner", "-i", framePath, "-vf", "format=yuv444p,histogram", "-frames:v", "1", "-y", histogram]),
    runFfmpeg(["-hide_banner", "-i", framePath, "-vf", "format=yuv444p,waveform=intensity=0.2:mirror=1:components=7", "-frames:v", "1", "-y", waveform]),
    runFfmpeg(["-hide_banner", "-i", framePath, "-vf", "format=yuv444p,vectorscope=mode=color3", "-frames:v", "1", "-y", vectorscope]),
  ]);

  return { stats: { luma, saturation, hue, rgb, notes }, scopes: { histogram, waveform, vectorscope } };
}
