import { pathToFileURL, fileURLToPath } from "node:url";
import { newId } from "../ids.js";
import {
  clipDurationFrames,
  PROJECT_SCHEMA_VERSION,
  type Clip,
  type MediaAsset,
  type Project,
  type Track,
  type TransitionType,
} from "../types.js";

/**
 * OpenTimelineIO interop — "start the edit with AI in SynthCut, finish
 * anywhere". OTIO (Apache-2.0) is plain JSON, so this is careful serialization
 * with no dependency:
 *
 *  - projectToOtio: Timeline.1 → one Stack of Track.1s (Video/Audio, bottom→top
 *    in stacking order). Clips become Clip.2 + ExternalReference.1 (absolute
 *    file URL + available_range); gaps between absolutely-positioned clips
 *    become Gap.1s; transitions become Transition.1 (SMPTE_Dissolve,
 *    in/out offsets = overlap/2, centered on the cut); speed becomes a
 *    LinearTimeWarp.1. Everything OTIO can't express (effects stack, keyframes,
 *    captions, graphics, adjustment layers, exact overlap frames) rides under
 *    `metadata.synthcut.*`, so a SynthCut→SynthCut round-trip is LOSSLESS.
 *
 *  - otioToProject: maps tracks/clips/gaps/transitions back. When
 *    metadata.synthcut is present the original objects are restored verbatim;
 *    foreign OTIO is mapped structurally (cut positions from the sequence,
 *    transitions to overlap crossfades) and anything unmappable lands in the
 *    returned `warnings`.
 */

// ---- OTIO JSON shapes (the subset we read/write) -----------------------------

interface OtioRationalTime {
  OTIO_SCHEMA: "RationalTime.1";
  rate: number;
  value: number;
}

interface OtioTimeRange {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

interface OtioExternalReference {
  OTIO_SCHEMA: "ExternalReference.1";
  target_url: string;
  available_range?: OtioTimeRange | null;
  metadata?: Record<string, unknown>;
}

interface OtioItem {
  OTIO_SCHEMA: string;
  name?: string;
  metadata?: Record<string, unknown>;
  source_range?: OtioTimeRange | null;
  // Clip.2
  media_references?: Record<string, OtioExternalReference>;
  active_media_reference_key?: string;
  // Clip.1 (read-compat)
  media_reference?: OtioExternalReference;
  effects?: Array<Record<string, unknown>>;
  // Transition.1
  transition_type?: string;
  in_offset?: OtioRationalTime;
  out_offset?: OtioRationalTime;
}

interface OtioTrack {
  OTIO_SCHEMA: "Track.1";
  name?: string;
  kind: "Video" | "Audio";
  children: OtioItem[];
  metadata?: Record<string, unknown>;
}

interface OtioTimeline {
  OTIO_SCHEMA: "Timeline.1";
  name?: string;
  global_start_time?: OtioRationalTime | null;
  metadata?: Record<string, unknown>;
  tracks: {
    OTIO_SCHEMA: "Stack.1";
    name?: string;
    children: OtioTrack[];
    metadata?: Record<string, unknown>;
  };
}

const rt = (value: number, rate: number): OtioRationalTime => ({
  OTIO_SCHEMA: "RationalTime.1",
  rate,
  value: Math.round(value),
});

const range = (startFrames: number, durFrames: number, rate: number): OtioTimeRange => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rt(startFrames, rate),
  duration: rt(Math.max(1, durFrames), rate),
});

// ---- export -------------------------------------------------------------------

/** Serialize a project as an OpenTimelineIO Timeline (plain JSON object). */
export function projectToOtio(project: Project): OtioTimeline {
  const fps = project.fps;
  const assetById = new Map(project.assets.map((a) => [a.id, a]));

  const tracks: OtioTrack[] = [...project.tracks]
    .sort((a, b) => a.index - b.index) // OTIO stacks bottom→top; so do we
    .map((track) => {
      const children: OtioItem[] = [];
      const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
      let cursor = 0;

      for (const clip of clips) {
        const footprint = clipDurationFrames(clip);
        const overlap = clip.transition ? Math.min(clip.transition.durationFrames, footprint - 1) : 0;

        if (!clip.transition && clip.startFrame > cursor) {
          // Positional gap → explicit OTIO Gap.
          children.push({
            OTIO_SCHEMA: "Gap.1",
            source_range: range(0, clip.startFrame - cursor, fps),
          });
        }

        if (clip.transition && overlap > 0) {
          children.push({
            OTIO_SCHEMA: "Transition.1",
            name: clip.transition.type,
            transition_type: "SMPTE_Dissolve",
            in_offset: rt(Math.floor(overlap / 2), fps),
            out_offset: rt(Math.ceil(overlap / 2), fps),
            metadata: { synthcut: { type: clip.transition.type, durationFrames: clip.transition.durationFrames } },
          });
        }

        const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
        const speed = clip.effects?.speed ?? 1;
        // In the OTIO sequence, a transition doesn't consume time — the item
        // sequence stays butt-cut. Our overlap pulls the clip left, so its
        // sequential duration is footprint - overlap (timeline end matches).
        const seqDur = footprint - overlap;

        const item: OtioItem = {
          OTIO_SCHEMA: "Clip.2",
          name: clip.adjustment ? "Adjustment layer" : asset?.name ?? "clip",
          source_range: range(clip.sourceInFrame, seqDur, fps),
          media_references: {
            DEFAULT_MEDIA: asset
              ? {
                  OTIO_SCHEMA: "ExternalReference.1",
                  target_url: pathToFileURL(asset.path).href,
                  available_range: range(0, Math.max(1, Math.round(asset.duration * fps)), fps),
                  metadata: { synthcut: { asset: stripCaches(asset) } },
                }
              : {
                  OTIO_SCHEMA: "ExternalReference.1",
                  target_url: "",
                  available_range: null,
                  metadata: { synthcut: { adjustment: true } },
                },
          },
          active_media_reference_key: "DEFAULT_MEDIA",
          // Lossless round-trip: the ENTIRE original clip rides in metadata.
          metadata: { synthcut: { clip: structuredClone(clip) } },
        };
        if (speed !== 1) {
          item.effects = [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "speed", time_scalar: speed }];
        }
        children.push(item);
        cursor = clip.startFrame + footprint;
      }

      return {
        OTIO_SCHEMA: "Track.1" as const,
        name: track.name ?? `${track.kind === "video" ? "V" : "A"}${track.index}`,
        kind: track.kind === "video" ? ("Video" as const) : ("Audio" as const),
        children,
        metadata: { synthcut: { index: track.index, muted: track.muted, volume: track.volume, hidden: track.hidden, locked: track.locked } },
      };
    });

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: project.name,
    global_start_time: rt(0, fps),
    metadata: {
      synthcut: {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        width: project.width,
        height: project.height,
        fps,
        markers: project.markers,
        music: project.music,
        folders: project.folders,
        // The full media library (identity + probe data, caches stripped) — so
        // unplaced assets (e.g. the music bed) and asset ids survive re-import.
        assets: project.assets.map(stripCaches),
      },
    },
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: tracks },
  };
}

/** An asset as persisted in OTIO metadata (derived caches never travel). */
function stripCaches(asset: MediaAsset): MediaAsset {
  const { transcript, visualSig, ...rest } = asset;
  void transcript;
  void visualSig;
  return rest as MediaAsset;
}

// ---- import -------------------------------------------------------------------

export interface OtioImportResult {
  project: Project;
  /** Structural information OTIO carried that we could not express. */
  warnings: string[];
  /** Referenced media files that don't exist on disk (imported as offline placeholders). */
  missing: string[];
}

const framesAt = (t: OtioRationalTime | undefined, fps: number): number =>
  t ? Math.round((t.value / t.rate) * fps) : 0;

/**
 * Map an OTIO Timeline back into a project. `probe` resolves a media path to a
 * probed asset (returns null when the file is missing — the caller supplies
 * ffprobe; missing files become offline placeholder assets with missing:true).
 */
export async function otioToProject(
  json: unknown,
  probe: (path: string) => Promise<MediaAsset | null>,
): Promise<OtioImportResult> {
  const t = json as OtioTimeline;
  if (t?.OTIO_SCHEMA !== "Timeline.1" || t.tracks?.OTIO_SCHEMA !== "Stack.1") {
    throw new Error(
      "Not an OpenTimelineIO file: expected a JSON Timeline.1 with a Stack.1 `tracks`. Export one from SynthCut with export_otio, or from any OTIO-capable NLE.",
    );
  }
  const warnings: string[] = [];
  const missing: string[] = [];

  const sc = (t.metadata?.synthcut ?? {}) as Partial<{
    width: number;
    height: number;
    fps: number;
    markers: Project["markers"];
    music: Project["music"];
    folders: Project["folders"];
    assets: MediaAsset[];
  }>;

  // fps: our metadata, else the first RationalTime rate we can find.
  const firstRate = t.tracks.children
    .flatMap((tr) => tr.children)
    .map((c) => c.source_range?.duration.rate)
    .find((r) => typeof r === "number" && r > 0);
  const fps = sc.fps ?? firstRate ?? 30;

  const now = Date.now();
  const assetsByPath = new Map<string, MediaAsset>();
  const tracks: Track[] = [];

  // Seed the library from the traveled SynthCut asset list (keeps asset ids and
  // unplaced assets like the music bed); probe refreshes reality on this disk.
  for (const ma of sc.assets ?? []) {
    const probed = await probe(ma.path);
    const asset: MediaAsset = probed
      ? {
          ...ma,
          duration: probed.duration,
          width: probed.width,
          height: probed.height,
          fps: probed.fps,
          hasVideo: probed.hasVideo,
          hasAudio: probed.hasAudio,
        }
      : { ...ma, missing: true };
    if (!probed) missing.push(ma.path);
    assetsByPath.set(ma.path, asset);
  }

  for (let ti = 0; ti < t.tracks.children.length; ti++) {
    const otioTrack = t.tracks.children[ti];
    if (otioTrack.OTIO_SCHEMA !== "Track.1") {
      warnings.push(`Skipped unknown stack child "${otioTrack.OTIO_SCHEMA}"`);
      continue;
    }
    const tsc = (otioTrack.metadata?.synthcut ?? {}) as Partial<{ index: number; muted: boolean; volume: number; hidden: boolean; locked: boolean }>;
    const kind = otioTrack.kind === "Audio" ? "audio" : "video";
    const track: Track = {
      id: newId("track"),
      kind,
      index: tsc.index ?? ti,
      name: otioTrack.name,
      muted: tsc.muted,
      volume: tsc.volume,
      hidden: tsc.hidden,
      locked: tsc.locked,
      clips: [],
    };

    let cursor = 0;
    let pendingTransition: { type: string; durationFrames: number } | null = null;

    for (const item of otioTrack.children ?? []) {
      if (item.OTIO_SCHEMA === "Gap.1") {
        cursor += framesAt(item.source_range?.duration, fps);
        continue;
      }
      if (item.OTIO_SCHEMA === "Transition.1") {
        const meta = (item.metadata?.synthcut ?? {}) as Partial<{ type: string; durationFrames: number }>;
        const dur = meta.durationFrames ?? framesAt(item.in_offset, fps) + framesAt(item.out_offset, fps);
        pendingTransition = { type: meta.type ?? "dissolve", durationFrames: Math.max(1, dur) };
        continue;
      }
      if (item.OTIO_SCHEMA !== "Clip.1" && item.OTIO_SCHEMA !== "Clip.2") {
        warnings.push(`Dropped unsupported track item "${item.OTIO_SCHEMA}" on ${otioTrack.name ?? kind}`);
        continue;
      }

      const ref =
        item.media_references?.[item.active_media_reference_key ?? "DEFAULT_MEDIA"] ?? item.media_reference;
      const clipMeta = (item.metadata?.synthcut ?? {}) as Partial<{ clip: Clip }>;
      const refMeta = (ref?.metadata?.synthcut ?? {}) as Partial<{ asset: MediaAsset; adjustment: boolean }>;

      // Resolve the media (dedup by path; probe; placeholder when missing).
      let assetId: string | undefined;
      if (ref?.target_url && !refMeta.adjustment) {
        let path: string;
        try {
          path = ref.target_url.startsWith("file:") ? fileURLToPath(ref.target_url) : ref.target_url;
        } catch {
          path = ref.target_url;
        }
        let asset = assetsByPath.get(path);
        if (!asset) {
          const probed = await probe(path);
          if (probed) {
            asset = probed;
          } else {
            missing.push(path);
            const availFrames = framesAt(ref.available_range?.duration, fps);
            const metaAsset = refMeta.asset;
            asset = {
              ...(metaAsset ?? {
                id: newId("asset"),
                name: path.split(/[\\/]/).pop() ?? "offline media",
                duration: availFrames > 0 ? availFrames / fps : 1,
                width: 0,
                height: 0,
                fps,
                hasVideo: kind === "video",
                hasAudio: kind === "audio",
                addedAt: now,
              }),
              path,
              missing: true,
            } as MediaAsset;
          }
          // Prefer the original SynthCut asset identity when it traveled along.
          if (refMeta.asset) asset = { ...refMeta.asset, ...asset, id: refMeta.asset.id };
          assetsByPath.set(path, asset);
        }
        assetId = asset.id;
      }

      if (clipMeta.clip) {
        // SynthCut round-trip: restore the exact original clip.
        const restored = structuredClone(clipMeta.clip);
        if (assetId && restored.assetId) restored.assetId = assetId;
        track.clips.push(restored);
        cursor = restored.startFrame + clipDurationFrames(restored);
        pendingTransition = null;
        continue;
      }

      // Foreign OTIO: place sequentially; a preceding transition becomes an
      // overlap crossfade (the clip is pulled left by its duration).
      const srcStart = framesAt(item.source_range?.start_time, fps);
      const dur = Math.max(1, framesAt(item.source_range?.duration, fps));
      const overlap = pendingTransition ? Math.min(pendingTransition.durationFrames, dur - 1, Math.max(0, cursor)) : 0;
      const clip: Clip = {
        id: newId("clip"),
        assetId,
        adjustment: refMeta.adjustment ? true : undefined,
        startFrame: Math.max(0, cursor - overlap),
        sourceInFrame: srcStart,
        sourceOutFrame: srcStart + dur + overlap,
        transition:
          overlap > 0 && pendingTransition
            ? { type: pendingTransition.type as TransitionType, durationFrames: overlap }
            : undefined,
      };
      const warp = item.effects?.find((e) => e.OTIO_SCHEMA === "LinearTimeWarp.1");
      if (warp && typeof warp.time_scalar === "number" && warp.time_scalar !== 1) {
        clip.effects = { speed: Math.min(4, Math.max(0.25, warp.time_scalar)) };
      }
      for (const e of item.effects ?? []) {
        if (e.OTIO_SCHEMA !== "LinearTimeWarp.1") warnings.push(`Dropped unsupported OTIO effect "${String(e.OTIO_SCHEMA)}" on "${item.name ?? "clip"}"`);
      }
      track.clips.push(clip);
      cursor = clip.startFrame + clipDurationFrames(clip);
      pendingTransition = null;
    }

    tracks.push(track);
  }

  // Ensure at least one video track exists (engine invariant).
  if (!tracks.some((tr) => tr.kind === "video")) {
    tracks.unshift({ id: newId("track"), kind: "video", index: -1, name: "V1", clips: [] });
    tracks.forEach((tr, i) => (tr.index = i));
  }

  const assets = [...assetsByPath.values()];
  const width = sc.width ?? assets.find((a) => a.width > 0)?.width ?? 1920;
  const height = sc.height ?? assets.find((a) => a.height > 0)?.height ?? 1080;

  const project: Project = {
    id: newId("proj"),
    name: t.name || "Imported timeline",
    width,
    height,
    fps,
    assets,
    folders: sc.folders,
    tracks,
    music: sc.music,
    markers: sc.markers,
    revision: 0,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  return { project, warnings, missing };
}
