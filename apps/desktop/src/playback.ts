// Playback engine primitives shared by the preview player and the timeline.
//
// The playhead moves ~60×/second. To keep that from re-rendering the whole app
// (library, inspector, asset list…), playhead/playing/duration live in a tiny
// external store. Only the components that actually draw the playhead — the
// timeline cursor and the transport clock — subscribe to it. The preview player
// owns the <video> element and is the clock that writes into the store; commands
// flow back to it through an imperative ref (see PlayerHandle).

import { useSyncExternalStore } from "react";
import type { Clip, MediaAsset, ColorAdjust, ColorGrade, VisualEffect } from "./types";

export interface PlaybackState {
  playhead: number;
  playing: boolean;
  duration: number;
}

export interface PlaybackStore {
  get: () => PlaybackState;
  set: (patch: Partial<PlaybackState>) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackStore(): PlaybackStore {
  let state: PlaybackState = { playhead: 0, playing: false, duration: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      // Skip notify if nothing actually changed (avoids redundant renders).
      const changed =
        (patch.playhead !== undefined && patch.playhead !== state.playhead) ||
        (patch.playing !== undefined && patch.playing !== state.playing) ||
        (patch.duration !== undefined && patch.duration !== state.duration);
      if (!changed) return;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to one derived slice of the store (primitive results only). */
export function usePlaybackValue<T>(store: PlaybackStore, select: (s: PlaybackState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

/** Imperative API the timeline / transport use to drive the preview player. */
export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  /** Nudge by whole frames (± direction × count). */
  step: (frames: number) => void;
  /** Jump to the start of the previous / next clip. */
  jumpClip: (dir: -1 | 1) => void;
}

/**
 * A clip flattened onto the timeline: where it sits (start/end in timeline
 * seconds) and which slice of its source it shows. `tlDur` already accounts for
 * speed, so the timeline and the source playhead stay in lockstep.
 */
export interface Segment {
  clip: Clip;
  asset?: MediaAsset;
  index: number;
  start: number;
  end: number;
  tlDur: number;
  speed: number;
  srcIn: number;
  srcOut: number;
  path?: string;
  /** Project fps, carried so consumers can convert the clip's frame fields. */
  fps: number;
}

/**
 * Flatten a track's clips into timeline segments (in seconds) using each clip's
 * ABSOLUTE frame position. Source trims and start are converted from frames at
 * the boundary; `tlDur` accounts for speed.
 */
export function buildSegments(clips: Clip[], assetById: Map<string, MediaAsset>, fps: number): Segment[] {
  return clips.map((clip, index) => {
    const speed = clip.effects?.speed ?? 1;
    const srcIn = clip.sourceInFrame / fps;
    const srcOut = clip.sourceOutFrame / fps;
    const tlDur = Math.max(0.01, (srcOut - srcIn) / speed);
    const start = clip.startFrame / fps;
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined; // adjustment layers have no source
    // Preview prefers a low-res proxy when one exists; export uses the original.
    return { clip, asset, index, start, end: start + tlDur, tlDur, speed, srcIn, srcOut, path: asset?.proxyPath ?? asset?.path, fps };
  });
}

export function totalDuration(segments: Segment[]): number {
  return segments.length ? segments[segments.length - 1].end : 0;
}

/** Which segment is under a given timeline time (clamped to the last clip). */
export function segmentAt(segments: Segment[], time: number): Segment | undefined {
  if (!segments.length) return undefined;
  for (const s of segments) {
    if (time >= s.start && time < s.end) return s;
  }
  return segments[segments.length - 1];
}

/** Source time inside a segment for a given timeline time. */
export function sourceTimeFor(seg: Segment, time: number): number {
  return seg.srcIn + Math.max(0, time - seg.start) * seg.speed;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Approximate the engine's color pipeline (eq + secondary grade + simple
 * effects) with CSS filters for instant preview. Not pixel-identical to the
 * FFmpeg export — it's a live proxy so you can judge a look without rendering.
 * Curves, LUTs, color wheels and most effects are export-only (FFmpeg is the
 * ground truth); we map what CSS can express: brightness/contrast/saturation,
 * hue rotation, warm/cool tint, blur, grayscale, sepia.
 */
export function colorFilter(color?: ColorAdjust, grade?: ColorGrade, filters?: VisualEffect[]): string {
  const parts: string[] = [];
  if (color) {
    if (color.brightness !== undefined && color.brightness !== 0) parts.push(`brightness(${clamp(1 + color.brightness, 0, 4)})`);
    if (color.contrast !== undefined && color.contrast !== 1) parts.push(`contrast(${clamp(color.contrast, 0, 4)})`);
    if (color.saturation !== undefined && color.saturation !== 1) parts.push(`saturate(${clamp(color.saturation, 0, 4)})`);
  }
  if (grade) {
    if (grade.hue) parts.push(`hue-rotate(${grade.hue}deg)`);
    // Warm temperature reads as a slight sepia; cool as a hue nudge toward blue.
    if (grade.temperature && grade.temperature > 0) parts.push(`sepia(${clamp(grade.temperature * 0.5, 0, 1)})`);
    else if (grade.temperature && grade.temperature < 0) parts.push(`hue-rotate(${grade.temperature * 20}deg)`);
  }
  for (const f of filters ?? []) {
    if (f.type === "blur") parts.push(`blur(${clamp(f.amount ?? 8, 0, 50) / 5}px)`);
    else if (f.type === "grayscale") parts.push("grayscale(1)");
    else if (f.type === "sepia") parts.push("sepia(0.85)");
    else if (f.type === "vignette") parts.push("contrast(1.1) brightness(0.95)");
  }
  return parts.length ? parts.join(" ") : "none";
}

/** Opacity from fade-in / fade-out within a segment at the given timeline time. */
export function fadeOpacity(seg: Segment, time: number): number {
  const fx = seg.clip.effects;
  if (!fx) return 1;
  const fadeIn = fx.fadeInFrames ? fx.fadeInFrames / seg.fps : 0;
  const fadeOut = fx.fadeOutFrames ? fx.fadeOutFrames / seg.fps : 0;
  const into = time - seg.start;
  const left = seg.end - time;
  let o = 1;
  if (fadeIn && into < fadeIn) o = Math.min(o, Math.max(0, into / fadeIn));
  if (fadeOut && left < fadeOut) o = Math.min(o, Math.max(0, left / fadeOut));
  return o;
}

/** M:SS, optionally with centiseconds (M:SS.cs) for the transport read-out. */
export function fmtTime(seconds: number, withCs = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (!withCs) return base;
  const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
  return `${base}.${String(cs).padStart(2, "0")}`;
}

/** Nice ruler tick spacing (seconds) for a given pixels-per-second zoom. */
export function tickInterval(pxPerSec: number): number {
  const targetPx = 84; // aim for a label roughly every ~84px
  const raw = targetPx / pxPerSec;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= raw) return s;
  return 600;
}
