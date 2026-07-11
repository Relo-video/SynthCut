import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Canvas, ResolvedRenderClip } from "../types.js";
import type { RenderProfile } from "./graph.js";

/**
 * Segment planning for the PREVIEW render cache. The timeline is cut at every
 * "edit boundary" (any clip start/end across tracks), then greedily merged into
 * segments of ~2–10 s. Each segment renders VIDEO-ONLY into an MPEG-TS file
 * keyed by a content hash of everything that affects its pixels, so an edit at
 * the tail of a long timeline re-renders only the tail segments; the preview is
 * assembled by lossless concat + ONE cheap full-timeline audio pass.
 */

/** Bump when the render pipeline changes in a way that invalidates cached pixels. */
const CACHE_VERSION = 2;

const MIN_SEG = 2; // seconds — merge primitives up to at least this
const MAX_SEG = 10; // seconds — stop merging past this

export interface PlannedSegment {
  /** Absolute timeline window, seconds. */
  start: number;
  end: number;
}

/** Cut points at every clip edge, then greedy-merge to 2–10s segments. */
export function planSegments(clips: ResolvedRenderClip[], totalDuration: number): PlannedSegment[] {
  const eps = 1e-3;
  const cuts = new Set<number>([0]);
  for (const c of clips) {
    if (c.startSec > eps && c.startSec < totalDuration - eps) cuts.add(Number(c.startSec.toFixed(3)));
    const end = c.startSec + c.outDuration;
    if (end > eps && end < totalDuration - eps) cuts.add(Number(end.toFixed(3)));
  }
  cuts.add(Number(totalDuration.toFixed(3)));
  const points = [...cuts].sort((a, b) => a - b);

  // Primitive spans between consecutive boundaries → greedy merge.
  const out: PlannedSegment[] = [];
  let start = points[0];
  for (let i = 1; i < points.length; i++) {
    const end = points[i];
    const len = end - start;
    const isLast = i === points.length - 1;
    // Keep growing while the merged span is under MIN_SEG, unless growing would
    // blow past MAX_SEG (then cut here anyway).
    if (!isLast && len < MIN_SEG && points[i + 1] - start <= MAX_SEG) continue;
    if (end - start > eps) out.push({ start, end });
    start = end;
  }
  if (out.length === 0 && totalDuration > 0) out.push({ start: 0, end: totalDuration });
  return out;
}

/** Clips whose footage intersects [start, end) — the segment's dependencies. */
export function clipsIntersecting(clips: ResolvedRenderClip[], seg: PlannedSegment): ResolvedRenderClip[] {
  return clips.filter((c) => c.startSec < seg.end && c.startSec + c.outDuration > seg.start);
}

/** mtimes of every file a set of clips references (sources, LUTs are staged-relative, graphics). */
export async function collectMtimes(clips: ResolvedRenderClip[]): Promise<Record<string, number>> {
  const paths = new Set<string>();
  for (const c of clips) {
    paths.add(c.path);
    for (const g of c.graphics ?? []) paths.add(g.path);
  }
  const out: Record<string, number> = {};
  await Promise.all(
    [...paths].map(async (p) => {
      try {
        out[p] = Math.round((await stat(p)).mtimeMs);
      } catch {
        out[p] = -1;
      }
    }),
  );
  return out;
}

/**
 * Content key for one segment: sha1 over the canvas, encode settings, and the
 * JSON of every intersecting resolved clip with its position REBASED to the
 * segment window (so identical content reuses cache regardless of where it
 * sits on the timeline) plus source-file mtimes.
 */
export function segmentKey(
  clips: ResolvedRenderClip[],
  seg: PlannedSegment,
  canvas: Canvas,
  profile: RenderProfile,
  mtimes: Record<string, number>,
  hwEncoder: string | null | undefined,
): string {
  const deps = clipsIntersecting(clips, seg).map((c) => ({
    ...c,
    startSec: Number((c.startSec - seg.start).toFixed(6)),
    mtime: mtimes[c.path] ?? -1,
    graphicMtimes: (c.graphics ?? []).map((g) => mtimes[g.path] ?? -1),
  }));
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    w: canvas.width,
    h: canvas.height,
    fps: canvas.fps,
    dur: Number((seg.end - seg.start).toFixed(6)),
    crf: profile.crf,
    preset: profile.preset,
    enc: hwEncoder ?? "sw",
    deps,
  });
  return createHash("sha1").update(payload).digest("hex");
}
