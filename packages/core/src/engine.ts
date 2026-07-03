import { EventEmitter } from "node:events";
import { mkdir, writeFile, readFile, copyFile, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";
import { newId } from "./ids.js";
import { probeAsset } from "./ffmpeg/ffprobe.js";
import {
  detectSilence,
  detectScenes,
  inspectFrameColor,
  type SilenceRange,
  type SceneCut,
  type ColorInspection,
} from "./ffmpeg/analysis.js";
import { runFfmpeg } from "./ffmpeg/executor.js";
import { transcribe, type TranscriptCue } from "./whisper/transcribe.js";
import { DEFAULT_MODEL, type WhisperModel } from "./whisper/setup.js";
import { buildSignature, buildReferenceSample, signatureSimilarity } from "./media/signature.js";
import { findAudioOffset, type AudioSyncResult } from "./media/audiosync.js";
import { rankTranscript, type TranscriptHit } from "./media/search.js";
import { embedImage, embedText, ensureClip, cosine } from "./media/clip.js";
import { trackSubject, buildCropPlan, cropPlanToSendcmd } from "./reframe/reframe.js";
import { renderGraphic } from "./motion/render.js";
import {
  sortKeyframes,
  type Keyframe,
  type KeyframeProperty,
  type Transform,
} from "./keyframes.js";
import {
  buildRenderCommand,
  buildThumbnailCommand,
  previewCanvas,
  EXPORT_PROFILE,
  PREVIEW_PROFILE,
  type ResolvedMusic,
} from "./ffmpeg/graph.js";
import {
  clipDurationFrames,
  clipEndFrame,
  framesToSeconds,
  secondsToFrames,
  PROJECT_SCHEMA_VERSION,
  type Canvas,
  type Captions,
  type CaptionCue,
  type CaptionStyle,
  type AssetTranscript,
  type Clip,
  type ClipEffects,
  type ColorGrade,
  type ExportSettings,
  type GraphicOverlay,
  type MediaFolder,
  type VisualSignature,
  type MediaAsset,
  type Project,
  type ResolvedEffects,
  type ResolvedGraphic,
  type ResolvedKeyframe,
  type ResolvedOverlay,
  type ResolvedRenderClip,
  type TextAnimProperty,
  type TextOverlay,
  type TextStyle,
  type Track,
  type TrackKind,
  type TransitionType,
} from "./types.js";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Sources whose long edge exceeds this auto-get a preview proxy (4K and up). */
const PROXY_TRIGGER_LONG_EDGE = 1920;
/** Proxy long-edge resolution (720p-class) — small enough to scrub smoothly. */
const PROXY_LONG_EDGE = 1280;

/**
 * Sensible default text styling for when the AI/user doesn't specify it: a crisp,
 * universally-legible "bold social" look — size proportional to the canvas height,
 * with a black outline + soft drop shadow so it reads on ANY footage (no heavy box
 * needed). Only a fallback; any explicit style field the caller sets always wins.
 */
function defaultTextStyle(canvasHeight: number, fontSize?: number): {
  fontSize: number; outlineWidth: number; shadowY: number; boxBorderW: number;
} {
  const fs = fontSize ?? Math.max(24, Math.round(canvasHeight * 0.05));
  return {
    fontSize: fs,
    outlineWidth: Math.max(2, Math.round(fs / 12)),
    shadowY: Math.max(1, Math.round(fs / 22)),
    boxBorderW: Math.max(6, Math.round(fs * 0.28)),
  };
}

/** Resolve a text overlay's clip-local frame keyframes to clip-local seconds. */
function resolveOverlayKeyframes(
  kf: Partial<Record<TextAnimProperty, Keyframe[]>>,
  f2s: (f: number) => number,
): Partial<Record<TextAnimProperty, ResolvedKeyframe[]>> {
  const out: Partial<Record<TextAnimProperty, ResolvedKeyframe[]>> = {};
  for (const prop of ["x", "y", "opacity"] as TextAnimProperty[]) {
    const track = kf[prop];
    if (track?.length) out[prop] = track.map((k) => ({ sec: f2s(k.frame), value: k.value, ease: k.ease }));
  }
  return out;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Directories scanned to resolve a font family name to a font file. */
const FONT_DIRS = [
  process.env.WINDIR ? join(process.env.WINDIR, "Fonts") : "C:/Windows/Fonts",
  // Per-user Windows fonts (a "Install for me / current user" or a font dropped
  // here without admin rights — e.g. a downloaded Google Font). Scanned so those
  // resolve in the export the same way the OS already shows them to the preview.
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Microsoft/Windows/Fonts")] : []),
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  join(homedir(), ".fonts"),
  join(homedir(), "Library/Fonts"),
  "/usr/share/fonts",
  "/usr/local/share/fonts",
];

function fontKey(s: string): string {
  return s.toLowerCase().replace(/\.(ttf|otf|ttc)$/i, "").replace(/[\s_-]+/g, "");
}

// A few common family names whose installed filename doesn't contain the family
// name (so the generic substring match misses them). Maps fontKey → filename key.
const FONT_ALIASES: Record<string, string> = {
  arialblack: "ariblk",
  arialnarrow: "arialn",
  segoeuiblack: "seguibl",
  segoeuisemibold: "seguisb",
};

function fontMatches(file: string, want: string): boolean {
  if (!/\.(ttf|otf|ttc)$/i.test(file)) return false;
  const base = fontKey(file);
  if (want.length < 3) return base === want;
  return base === want || base.includes(want) || want.includes(base);
}

/**
 * Best-effort resolution of a font family NAME to an installed font file
 * (one level of subdirectory deep, to cover Linux's nested font tree). Returns
 * undefined if nothing matches — callers fall back to the default font.
 */
async function findSystemFont(name: string): Promise<string | undefined> {
  const want = fontKey(name);
  if (!want) return undefined;
  const alias = FONT_ALIASES[want];
  const matches = (file: string) => fontMatches(file, want) || (alias ? fontMatches(file, alias) : false);
  for (const dir of FONT_DIRS) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        try {
          const sub = await readdir(join(dir, e.name));
          for (const f of sub) if (matches(f)) return join(dir, e.name, f);
        } catch {
          /* unreadable subdir */
        }
        continue;
      }
      if (matches(e.name)) return join(dir, e.name);
    }
  }
  return undefined;
}

/** Round down to the nearest even integer (x264 requires even dimensions). */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Minimum clip footprint, in frames. */
const MIN_CLIP_FRAMES = 1;
const MAX_HISTORY = 100;

export interface RenderResult {
  /** Absolute path to the rendered file. */
  path: string;
  /** Output duration in seconds. */
  duration: number;
}

export interface EngineEvents {
  change: (project: Project) => void;
  progress: (info: { job: "preview" | "export"; fraction: number }) => void;
}

function defaultProject(): Project {
  const now = Date.now();
  return {
    id: newId("proj"),
    name: "Untitled Project",
    width: 1920,
    height: 1080,
    fps: 30,
    assets: [],
    tracks: [{ id: newId("track"), kind: "video", index: 0, name: "V1", clips: [] }],
    revision: 0,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The single source of truth for an editing session. All edits mutate the
 * in-memory project; every mutation bumps the revision, persists nothing by
 * itself, and emits a `change` event so connected clients (UI + AI) stay in
 * sync. Source media is never modified — editing is purely an EDL.
 *
 * The timeline is multi-track and frame-based: every position/duration is an
 * integer count of project frames (`project.fps`). Frames are only converted to
 * seconds at the FFmpeg boundary (see {@link stageRender}).
 */
export class EditorEngine extends EventEmitter {
  private project: Project = defaultProject();
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private canvasAdopted = false;
  /** Absolute path of the .aive file this project was last saved to / loaded from
   *  (undefined for a never-saved project). Lets the UI Save without re-asking and
   *  tells the AI which project file is open. Not part of the saved JSON. */
  private currentPath: string | undefined;
  /** `project.revision` as of the last save/load. The project has unsaved changes
   *  whenever the live revision has moved past this. A fresh project starts clean. */
  private lastSavedRevision = 0;
  private previewAbort: AbortController | null = null;
  private previewCache: { revision: number; path: string } | null = null;

  /** Directory where previews, thumbnails and other render artifacts are written. */
  constructor(readonly dataDir: string) {
    super();
  }

  // ---- typed event helpers ---------------------------------------------------
  override on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof EngineEvents>(event: E, ...args: Parameters<EngineEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  // ---- state access ----------------------------------------------------------
  getProject(): Project {
    return this.project;
  }

  get fps(): number {
    return this.project.fps;
  }

  getAsset(assetId: string): MediaAsset {
    const asset = this.project.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(`No asset with id "${assetId}"`);
    return asset;
  }

  /** Video tracks, bottom→top (ascending stacking index). */
  private videoTracks(): Track[] {
    return this.project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index);
  }

  /** All tracks in stacking order. */
  private tracksByIndex(): Track[] {
    return [...this.project.tracks].sort((a, b) => a.index - b.index);
  }

  /** The lowest-index video track (the default placement target). */
  private baseVideoTrack(): Track {
    const v = this.videoTracks();
    if (v.length === 0) throw new Error("Project has no video track");
    return v[0];
  }

  private trackByIndex(index: number): Track {
    const track = this.project.tracks.find((t) => t.index === index);
    if (!track) throw new Error(`No track with index ${index}`);
    return track;
  }

  private nextTrackIndex(): number {
    return this.project.tracks.reduce((m, t) => Math.max(m, t.index), -1) + 1;
  }

  private findClip(clipId: string): { track: Track; clip: Clip; index: number } {
    for (const track of this.project.tracks) {
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index !== -1) return { track, clip: track.clips[index], index };
    }
    throw new Error(`No clip with id "${clipId}"`);
  }

  /** Keep a track's clips ordered by their start position. */
  private static sortTrack(track: Track): void {
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  }

  /** All clips sharing a clip's link group (including itself). */
  private linkedClips(clip: Clip): Clip[] {
    if (!clip.linkGroupId) return [clip];
    const group: Clip[] = [];
    for (const t of this.project.tracks) {
      for (const c of t.clips) if (c.linkGroupId === clip.linkGroupId) group.push(c);
    }
    return group;
  }

  /** Frame position just past the last clip on a track (0 if empty). */
  private trackEndFrame(track: Track): number {
    return track.clips.reduce((m, c) => Math.max(m, clipEndFrame(c)), 0);
  }

  /** Timeline footprint of a clip on the timeline in seconds (accounts for speed). */
  clipDuration(clip: Clip): number {
    return framesToSeconds(clipDurationFrames(clip), this.project.fps);
  }

  /**
   * Slice a caption track to the clip-local frame range [from, to) and rebase
   * its cue times so `from` becomes 0 (used when splitting/cutting a clip).
   */
  private static sliceCaptions(captions: Captions | undefined, from: number, to: number): Captions | undefined {
    if (!captions) return undefined;
    const cues = captions.cues
      .filter((c) => c.endFrame > from && c.startFrame < to)
      .map((c) => ({
        startFrame: Math.max(0, c.startFrame - from),
        endFrame: Math.min(to, c.endFrame) - from,
        text: c.text,
      }))
      .filter((c) => c.endFrame > c.startFrame);
    if (cues.length === 0) return undefined;
    return { ...structuredClone(captions), cues };
  }

  // ---- mutation plumbing -----------------------------------------------------
  private mutate<T>(fn: () => T): T {
    this.undoStack.push(structuredClone(this.project));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    const result = fn();
    this.project.revision += 1;
    this.project.updatedAt = Date.now();
    this.emit("change", this.project);
    return result;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(structuredClone(this.project));
    this.project = prev;
    this.project.revision += 1;
    this.project.updatedAt = Date.now();
    this.emit("change", this.project);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(structuredClone(this.project));
    this.project = next;
    this.project.revision += 1;
    this.project.updatedAt = Date.now();
    this.emit("change", this.project);
    return true;
  }

  // ---- media import ----------------------------------------------------------
  async importVideo(path: string): Promise<MediaAsset> {
    if (!isAbsolute(path)) {
      throw new Error(`Import path must be absolute, got "${path}"`);
    }
    const asset = await probeAsset(path);
    this.mutate(() => {
      this.project.assets.push(asset);
      // Adopt the first imported video's geometry as the project canvas, unless
      // the user/AI has explicitly set canvas dimensions.
      if (!this.canvasAdopted && asset.hasVideo && asset.width > 0 && asset.height > 0) {
        this.project.width = asset.width;
        this.project.height = asset.height;
        this.project.fps = asset.fps || this.project.fps;
        this.canvasAdopted = true;
      }
    });
    // Large/4K sources: build a low-res preview proxy in the BACKGROUND so import
    // returns immediately and scrubbing stays smooth. Export still uses the
    // original. Fire-and-forget; failures are non-fatal.
    if (asset.hasVideo && Math.max(asset.width, asset.height) > PROXY_TRIGGER_LONG_EDGE) {
      void this.generateProxy(asset.id).catch(() => {});
    }
    return asset;
  }

  /**
   * Transcode a low-res H.264 PROXY of an asset for snappy preview/scrub, cache
   * it, and record asset.proxyPath. Idempotent. The original is never modified
   * and EXPORT always uses it — proxies are a preview-only optimization.
   */
  async generateProxy(assetId: string, longEdge = PROXY_LONG_EDGE): Promise<MediaAsset> {
    const asset = this.getAsset(assetId);
    if (!asset.hasVideo) throw new Error("Asset has no video to proxy");
    const dir = join(this.dataDir, "proxies");
    await mkdir(dir, { recursive: true });
    const out = join(dir, `${assetId}.mp4`);
    if (!(await fileExists(out))) {
      // Scale the long edge down to `longEdge`, keep aspect, even dims; fast preset.
      const scale = asset.width >= asset.height
        ? `scale=${longEdge}:-2`
        : `scale=-2:${longEdge}`;
      const args = ["-hide_banner", "-i", asset.path, "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"];
      if (asset.hasAudio) args.push("-c:a", "aac", "-b:a", "128k");
      else args.push("-an");
      args.push("-movflags", "+faststart", "-y", out);
      await runFfmpeg(args);
    }
    return this.mutate(() => {
      const a = this.getAsset(assetId);
      a.proxyPath = out;
      return a;
    });
  }

  removeAsset(assetId: string): void {
    this.getAsset(assetId);
    this.mutate(() => {
      this.project.assets = this.project.assets.filter((a) => a.id !== assetId);
      for (const track of this.project.tracks) {
        track.clips = track.clips.filter((c) => c.assetId !== assetId);
      }
      if (this.project.music?.assetId === assetId) delete this.project.music;
    });
  }

  /** Set background music (mixed under the whole timeline). volume default 0.3. */
  setMusic(
    assetId: string,
    opts: { volume?: number; fadeInFrames?: number; fadeOutFrames?: number; duck?: boolean } = {},
  ): void {
    this.getAsset(assetId);
    this.mutate(() => {
      this.project.music = {
        assetId,
        volume: opts.volume ?? 0.3,
        fadeInFrames: opts.fadeInFrames,
        fadeOutFrames: opts.fadeOutFrames,
        duck: opts.duck ?? false,
      };
    });
  }

  /** Remove background music. */
  removeMusic(): void {
    this.mutate(() => {
      delete this.project.music;
    });
  }

  private resolveMusic(): ResolvedMusic | undefined {
    const m = this.project.music;
    if (!m) return undefined;
    const asset = this.project.assets.find((a) => a.id === m.assetId);
    if (!asset) return undefined;
    const fps = this.project.fps;
    return {
      path: asset.path,
      volume: m.volume,
      fadeIn: m.fadeInFrames ? framesToSeconds(m.fadeInFrames, fps) : undefined,
      fadeOut: m.fadeOutFrames ? framesToSeconds(m.fadeOutFrames, fps) : undefined,
      duck: m.duck,
    };
  }

  // ---- track operations ------------------------------------------------------
  /** Add a new track of the given kind on top of the stack. */
  addTrack(kind: TrackKind, opts: { name?: string; height?: number } = {}): Track {
    return this.mutate(() => {
      const sameKind = this.project.tracks.filter((t) => t.kind === kind).length;
      const track: Track = {
        id: newId("track"),
        kind,
        index: this.nextTrackIndex(),
        name: opts.name ?? `${kind === "video" ? "V" : "A"}${sameKind + 1}`,
        height: opts.height,
        clips: [],
      };
      this.project.tracks.push(track);
      return track;
    });
  }

  /** Remove a track (and its clips) by stacking index. Refuses the last video track. */
  removeTrack(trackIndex: number): void {
    this.mutate(() => {
      const track = this.trackByIndex(trackIndex);
      if (track.kind === "video" && this.videoTracks().length <= 1) {
        throw new Error("Cannot remove the last video track");
      }
      this.project.tracks = this.project.tracks.filter((t) => t.id !== track.id);
    });
  }

  /** Change a track's stacking index (z-order). Other tracks shift to make room. */
  reorderTrack(trackIndex: number, newIndex: number): void {
    this.mutate(() => {
      const track = this.trackByIndex(trackIndex);
      track.index = newIndex + (newIndex >= trackIndex ? 0.5 : -0.5);
      // Re-pack indices to consecutive integers, preserving the new order.
      this.tracksByIndex().forEach((t, i) => (t.index = i));
    });
  }

  /** Update a track's display/behaviour properties. */
  setTrackProperties(
    trackIndex: number,
    patch: { name?: string; muted?: boolean; volume?: number; hidden?: boolean; locked?: boolean; height?: number },
  ): Track {
    return this.mutate(() => {
      const track = this.trackByIndex(trackIndex);
      if (patch.name !== undefined) track.name = patch.name;
      if (patch.muted !== undefined) track.muted = patch.muted;
      if (patch.volume !== undefined) track.volume = Math.max(0, patch.volume);
      if (patch.hidden !== undefined) track.hidden = patch.hidden;
      if (patch.locked !== undefined) track.locked = patch.locked;
      if (patch.height !== undefined) track.height = patch.height;
      return track;
    });
  }

  // ---- clip placement --------------------------------------------------------
  private makeClip(
    assetId: string,
    startFrame: number,
    sourceInFrame?: number,
    sourceOutFrame?: number,
  ): Clip {
    const asset = this.getAsset(assetId);
    const fps = this.project.fps;
    const assetFrames = Math.max(MIN_CLIP_FRAMES, Math.round(asset.duration * fps));
    const inF = clamp(Math.round(sourceInFrame ?? 0), 0, assetFrames - MIN_CLIP_FRAMES);
    const outF = clamp(Math.round(sourceOutFrame ?? assetFrames), inF + MIN_CLIP_FRAMES, assetFrames);
    return {
      id: newId("clip"),
      assetId,
      startFrame: Math.max(0, Math.round(startFrame)),
      sourceInFrame: inF,
      sourceOutFrame: outF,
    };
  }

  /**
   * Place a clip on a track at an absolute frame. Defaults: base video track,
   * appended after the last clip, whole asset. Returns the created clip.
   */
  addClip(
    assetId: string,
    opts: { trackIndex?: number; startFrame?: number; sourceInFrame?: number; sourceOutFrame?: number } = {},
  ): Clip {
    return this.mutate(() => this.placeClip(assetId, opts));
  }

  /** Place several clips in one undoable step. */
  addClips(
    specs: { assetId: string; trackIndex?: number; startFrame?: number; sourceInFrame?: number; sourceOutFrame?: number }[],
  ): Clip[] {
    return this.mutate(() => specs.map((s) => this.placeClip(s.assetId, s)));
  }

  private placeClip(
    assetId: string,
    opts: { trackIndex?: number; startFrame?: number; sourceInFrame?: number; sourceOutFrame?: number },
  ): Clip {
    const track = opts.trackIndex === undefined ? this.baseVideoTrack() : this.trackByIndex(opts.trackIndex);
    const startFrame = opts.startFrame ?? this.trackEndFrame(track);
    const clip = this.makeClip(assetId, startFrame, opts.sourceInFrame, opts.sourceOutFrame);
    track.clips.push(clip);
    EditorEngine.sortTrack(track);
    return clip;
  }

  /** Convenience: append a clip to the end of the base video track. */
  appendClip(assetId: string, sourceInFrame?: number, sourceOutFrame?: number): Clip {
    return this.addClip(assetId, { sourceInFrame, sourceOutFrame });
  }

  /**
   * Insert a clip at a frame on a track, rippling later clips on that track to
   * the right by the inserted footprint so nothing is overwritten.
   */
  insertClip(
    assetId: string,
    opts: { trackIndex?: number; startFrame: number; sourceInFrame?: number; sourceOutFrame?: number },
  ): Clip {
    return this.mutate(() => {
      const track = opts.trackIndex === undefined ? this.baseVideoTrack() : this.trackByIndex(opts.trackIndex);
      const clip = this.makeClip(assetId, opts.startFrame, opts.sourceInFrame, opts.sourceOutFrame);
      const shift = clipDurationFrames(clip);
      for (const c of track.clips) if (c.startFrame >= clip.startFrame) c.startFrame += shift;
      track.clips.push(clip);
      EditorEngine.sortTrack(track);
      return clip;
    });
  }

  /** Re-trim a clip by setting new source in/out points (frames within the source). */
  trimClip(clipId: string, sourceInFrame?: number, sourceOutFrame?: number): Clip {
    return this.mutate(() => {
      const { track, clip } = this.findClip(clipId);
      const asset = this.getAsset(clip.assetId);
      const assetFrames = Math.max(MIN_CLIP_FRAMES, Math.round(asset.duration * this.project.fps));
      const newIn = sourceInFrame === undefined ? clip.sourceInFrame : clamp(Math.round(sourceInFrame), 0, assetFrames - MIN_CLIP_FRAMES);
      const newOut = sourceOutFrame === undefined ? clip.sourceOutFrame : clamp(Math.round(sourceOutFrame), newIn + MIN_CLIP_FRAMES, assetFrames);
      if (newOut - newIn < MIN_CLIP_FRAMES) throw new Error("Trim would make the clip too short");
      clip.sourceInFrame = newIn;
      clip.sourceOutFrame = newOut;
      EditorEngine.sortTrack(track);
      return clip;
    });
  }

  /**
   * Split a clip into two at `atFrame` measured from the clip's own start on the
   * timeline. Linked clips split at the same timeline frame. Returns ids.
   */
  splitClip(clipId: string, atFrame: number): { left: string; right: string } {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const splitAbs = clip.startFrame + Math.round(atFrame);
      const group = this.linkedClips(clip);
      let result = { left: clip.id, right: clip.id };
      for (const member of group) {
        const r = this.splitOne(member.id, splitAbs - member.startFrame);
        if (member.id === clip.id && r) result = r;
      }
      return result;
    });
  }

  /** Split a single clip; returns the new ids, or undefined if the cut misses it. */
  private splitOne(clipId: string, atFrame: number): { left: string; right: string } | undefined {
    const { track, clip, index } = this.findClip(clipId);
    const dur = clipDurationFrames(clip);
    if (atFrame <= MIN_CLIP_FRAMES || atFrame >= dur - MIN_CLIP_FRAMES) return undefined;
    const speed = clip.effects?.speed ?? 1;
    const splitSource = clip.sourceInFrame + Math.round(atFrame * speed);
    const left: Clip = {
      id: newId("clip"),
      assetId: clip.assetId,
      startFrame: clip.startFrame,
      sourceInFrame: clip.sourceInFrame,
      sourceOutFrame: splitSource,
      effects: structuredClone(clip.effects),
      transition: structuredClone(clip.transition),
      overlays: structuredClone(clip.overlays),
      captions: EditorEngine.sliceCaptions(clip.captions, 0, atFrame),
      graphics: structuredClone(clip.graphics),
      audioOffsetFrames: clip.audioOffsetFrames,
      linkGroupId: clip.linkGroupId,
    };
    const right: Clip = {
      id: newId("clip"),
      assetId: clip.assetId,
      startFrame: clip.startFrame + atFrame,
      sourceInFrame: splitSource,
      sourceOutFrame: clip.sourceOutFrame,
      effects: structuredClone(clip.effects),
      captions: EditorEngine.sliceCaptions(clip.captions, atFrame, dur),
      linkGroupId: clip.linkGroupId,
    };
    track.clips.splice(index, 1, left, right);
    EditorEngine.sortTrack(track);
    return { left: left.id, right: right.id };
  }

  /**
   * Remove a section [startFrame, endFrame) from within a clip (frames from the
   * clip's start). The footage to the right and all later clips on the track
   * close up (ripple left) by the removed amount. Returns the surviving clip ids.
   */
  cutRange(clipId: string, startFrame: number, endFrame: number): string[] {
    return this.mutate(() => {
      const { track, clip, index } = this.findClip(clipId);
      const dur = clipDurationFrames(clip);
      const s = Math.round(startFrame);
      const e = Math.round(endFrame);
      if (s < 0 || e > dur || s >= e) throw new Error(`Cut range [${s}, ${e}) must satisfy 0 <= start < end <= ${dur}`);
      const removed = e - s;
      const speed = clip.effects?.speed ?? 1;
      const remaining: Clip[] = [];
      if (s > MIN_CLIP_FRAMES) {
        remaining.push({
          id: newId("clip"),
          assetId: clip.assetId,
          startFrame: clip.startFrame,
          sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceInFrame + Math.round(s * speed),
          effects: structuredClone(clip.effects),
          transition: structuredClone(clip.transition),
          overlays: structuredClone(clip.overlays),
          captions: EditorEngine.sliceCaptions(clip.captions, 0, s),
          graphics: structuredClone(clip.graphics),
          audioOffsetFrames: clip.audioOffsetFrames,
        });
      }
      if (dur - e > MIN_CLIP_FRAMES) {
        remaining.push({
          id: newId("clip"),
          assetId: clip.assetId,
          startFrame: clip.startFrame + s,
          sourceInFrame: clip.sourceInFrame + Math.round(e * speed),
          sourceOutFrame: clip.sourceOutFrame,
          effects: structuredClone(clip.effects),
          captions: EditorEngine.sliceCaptions(clip.captions, e, dur),
        });
      }
      track.clips.splice(index, 1, ...remaining);
      // Close the gap: pull everything after the cut left by the removed amount.
      const cutAbs = clip.startFrame + e;
      for (const c of track.clips) if (c.startFrame >= cutAbs) c.startFrame -= removed;
      EditorEngine.sortTrack(track);
      return remaining.map((c) => c.id);
    });
  }

  /**
   * Ripple-delete timeline frame ranges on tracks: remove the covered footage
   * and close the gap (shift later clips left). Each range is {trackIndex,
   * startFrame, endFrame}. Processed back-to-front so positions stay valid.
   */
  rippleDeleteRanges(ranges: { trackIndex: number; startFrame: number; endFrame: number }[]): void {
    this.mutate(() => {
      for (const range of [...ranges].sort((a, b) => b.startFrame - a.startFrame)) {
        const track = this.trackByIndex(range.trackIndex);
        const s = Math.round(range.startFrame);
        const e = Math.round(range.endFrame);
        if (e <= s) continue;
        const removed = e - s;
        const kept: Clip[] = [];
        for (const c of track.clips) {
          const cs = c.startFrame;
          const ce = clipEndFrame(c);
          if (ce <= s || cs >= e) {
            kept.push(c); // fully outside the range
            continue;
          }
          // Trim away the overlapping part; keep left and/or right remainders.
          const speed = c.effects?.speed ?? 1;
          const dur = clipDurationFrames(c);
          if (cs < s) {
            const leftDur = s - cs;
            kept.push({
              ...structuredClone(c),
              id: newId("clip"),
              sourceOutFrame: c.sourceInFrame + Math.round(leftDur * speed),
              captions: EditorEngine.sliceCaptions(c.captions, 0, leftDur),
            });
          }
          if (ce > e) {
            const cutLocal = e - cs;
            kept.push({
              ...structuredClone(c),
              id: newId("clip"),
              startFrame: e,
              sourceInFrame: c.sourceInFrame + Math.round(cutLocal * speed),
              transition: undefined,
              captions: EditorEngine.sliceCaptions(c.captions, cutLocal, dur),
            });
          }
        }
        track.clips = kept;
        for (const c of track.clips) if (c.startFrame >= e) c.startFrame -= removed;
        EditorEngine.sortTrack(track);
      }
    });
  }

  removeClip(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const ids = new Set(this.linkedClips(clip).map((c) => c.id));
      for (const track of this.project.tracks) track.clips = track.clips.filter((c) => !ids.has(c.id));
    });
  }

  /**
   * Move a clip to an absolute frame on a (possibly different) track. Linked
   * clips move by the same delta. Clears any transition on the moved clip(s),
   * since the overlap they encoded no longer holds.
   */
  moveClip(clipId: string, startFrame: number, trackIndex?: number): void {
    this.mutate(() => {
      const { clip, track } = this.findClip(clipId);
      const delta = Math.max(0, Math.round(startFrame)) - clip.startFrame;
      const dest = trackIndex === undefined ? track : this.trackByIndex(trackIndex);
      const group = this.linkedClips(clip);
      for (const member of group) {
        const loc = this.findClip(member.id);
        member.startFrame = Math.max(0, member.startFrame + delta);
        delete member.transition;
        if (member.id === clipId && dest.id !== loc.track.id) {
          loc.track.clips.splice(loc.index, 1);
          dest.clips.push(member);
        }
      }
      for (const t of this.project.tracks) EditorEngine.sortTrack(t);
    });
  }

  /** Move several clips at once (each to an absolute track+frame). */
  moveClips(moves: { clipId: string; startFrame: number; trackIndex?: number }[]): void {
    for (const m of moves) this.moveClip(m.clipId, m.startFrame, m.trackIndex);
  }

  /** Link clips so they move/trim/split/delete together. Returns the group id. */
  linkClips(clipIds: string[]): string {
    return this.mutate(() => {
      const groupId = newId("link");
      for (const id of clipIds) this.findClip(id).clip.linkGroupId = groupId;
      return groupId;
    });
  }

  /** Unlink a clip (and its whole group) so they move independently again. */
  unlinkClip(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      for (const member of this.linkedClips(clip)) delete member.linkGroupId;
    });
  }

  /**
   * Merge effects into a clip (speed, volume, fades, color grade, LUT, crop).
   * `color` is deep-merged so you can tweak one channel at a time.
   */
  setClipEffects(clipId: string, patch: ClipEffects): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const current = clip.effects ?? {};
      const next: ClipEffects = { ...current, ...patch };
      if (patch.color) next.color = { ...(current.color ?? {}), ...patch.color };
      if (patch.grade) next.grade = { ...(current.grade ?? {}), ...patch.grade };
      if (next.speed !== undefined) next.speed = clamp(next.speed, 0.25, 4);
      if (next.volume !== undefined) next.volume = Math.max(0, next.volume);
      if (next.fadeInFrames !== undefined) next.fadeInFrames = Math.max(0, Math.round(next.fadeInFrames));
      if (next.fadeOutFrames !== undefined) next.fadeOutFrames = Math.max(0, Math.round(next.fadeOutFrames));
      clip.effects = next;
      return clip;
    });
  }

  /** Remove all effects from a clip. */
  clearClipEffects(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      delete clip.effects;
    });
  }

  /**
   * Merge a richer secondary color grade (white balance, lift/gamma/gain wheels,
   * hue, tone curves) into a clip. Deep-merged so you can nudge one field at a
   * time; pass null/undefined fields to leave them. Wheels are themselves merged.
   */
  setClipGrade(clipId: string, patch: ColorGrade): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const effects = clip.effects ?? (clip.effects = {});
      const current = effects.grade ?? {};
      const next: ColorGrade = { ...current, ...patch };
      // Merge the three wheels field-by-field so a single-channel nudge sticks.
      for (const w of ["lift", "gamma", "gain"] as const) {
        if (patch[w]) next[w] = { ...(current[w] ?? {}), ...patch[w] };
      }
      effects.grade = next;
      return clip;
    });
  }

  /**
   * Append (or update by id) a creative/utility visual effect on a clip. Effects
   * bake in order after color. Returns the clip and the effect's id.
   */
  applyEffect(
    clipId: string,
    effect: { id?: string; type: string; amount?: number; color?: string; params?: Record<string, number> },
  ): { clip: Clip; effectId: string } {
    let effectId = "";
    const clip = this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const effects = clip.effects ?? (clip.effects = {});
      const list = effects.filters ?? (effects.filters = []);
      const existing = effect.id ? list.find((f) => f.id === effect.id) : undefined;
      if (existing) {
        existing.type = effect.type;
        existing.amount = effect.amount;
        existing.color = effect.color;
        existing.params = effect.params;
        effectId = existing.id;
      } else {
        effectId = effect.id ?? newId("fx");
        list.push({ id: effectId, type: effect.type, amount: effect.amount, color: effect.color, params: effect.params });
      }
      return clip;
    });
    return { clip, effectId };
  }

  /** Remove one visual effect from a clip by id. */
  removeEffect(clipId: string, effectId: string): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      if (clip.effects?.filters) {
        clip.effects.filters = clip.effects.filters.filter((f) => f.id !== effectId);
        if (clip.effects.filters.length === 0) delete clip.effects.filters;
      }
      return clip;
    });
  }

  /**
   * Measure the color of the composited timeline at `atSeconds` (defaults to the
   * timeline midpoint): numeric scopes (luma/saturation/hue/mean-RGB + plain
   * notes) plus rendered histogram/waveform/vectorscope images. This is the AI's
   * color "eyes" — call it after a grade to verify the look objectively.
   */
  async inspectColor(atSeconds?: number): Promise<ColorInspection> {
    const framePath = await this.renderFrame(atSeconds);
    const scopeDir = join(this.dataDir, "scopes");
    await mkdir(scopeDir, { recursive: true });
    return inspectFrameColor(framePath, scopeDir, String(Date.now()));
  }

  // ---- Phase 6: media intelligence ------------------------------------------

  /** All library folders (stable order by creation). */
  listFolders(): MediaFolder[] {
    return [...(this.project.folders ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Create a library folder and return it. */
  createFolder(name: string): MediaFolder {
    const folder: MediaFolder = { id: newId("fld"), name: name.trim() || "Folder", createdAt: Date.now() };
    this.mutate(() => {
      (this.project.folders ?? (this.project.folders = [])).push(folder);
    });
    return folder;
  }

  /** Rename a folder. */
  renameFolder(folderId: string, name: string): MediaFolder {
    return this.mutate(() => {
      const folder = (this.project.folders ?? []).find((f) => f.id === folderId);
      if (!folder) throw new Error(`No folder with id "${folderId}"`);
      folder.name = name.trim() || folder.name;
      return folder;
    });
  }

  /** Delete a folder; its assets fall back to "no folder" (the assets are kept). */
  deleteFolder(folderId: string): void {
    this.mutate(() => {
      this.project.folders = (this.project.folders ?? []).filter((f) => f.id !== folderId);
      for (const a of this.project.assets) if (a.folderId === folderId) delete a.folderId;
    });
  }

  /** Move an asset into a folder (or pass null to move it out of any folder). */
  moveAssetToFolder(assetId: string, folderId: string | null): MediaAsset {
    return this.mutate(() => {
      const asset = this.getAsset(assetId);
      if (folderId) {
        if (!(this.project.folders ?? []).some((f) => f.id === folderId)) throw new Error(`No folder with id "${folderId}"`);
        asset.folderId = folderId;
      } else {
        delete asset.folderId;
      }
      return asset;
    });
  }

  /**
   * Transcribe a WHOLE asset and cache the transcript on it (spoken-word index
   * for search). Idempotent: re-running replaces the cached transcript.
   */
  async indexTranscript(
    assetId: string,
    opts: { model?: WhisperModel; language?: string } = {},
  ): Promise<{ asset: MediaAsset; segmentCount: number }> {
    const asset = this.getAsset(assetId);
    if (!asset.hasAudio) throw new Error("Asset has no audio to transcribe");

    const dir = join(this.dataDir, "transcripts");
    await mkdir(dir, { recursive: true });
    const wav = join(dir, `${assetId}.wav`);
    await runFfmpeg(["-hide_banner", "-i", asset.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav]);

    const model = opts.model ?? DEFAULT_MODEL;
    const cues: TranscriptCue[] = await transcribe(wav, { model, language: opts.language });
    const transcript: AssetTranscript = {
      segments: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
      model,
      language: opts.language ?? "en",
    };
    const updated = this.mutate(() => {
      this.getAsset(assetId).transcript = transcript;
      return this.getAsset(assetId);
    });
    return { asset: updated, segmentCount: transcript.segments.length };
  }

  /** Rank spoken-word hits across all INDEXED asset transcripts for a query. */
  searchTranscript(query: string, limit = 20): TranscriptHit[] {
    return rankTranscript(this.project.assets, query, limit);
  }

  /** The cached transcript of an asset (segments in seconds), or null if not indexed. */
  getTranscript(assetId: string): AssetTranscript | null {
    return this.getAsset(assetId).transcript ?? null;
  }

  /**
   * Locate a spoken phrase on the CURRENT timeline: for every placed clip whose
   * asset transcript matches the query within the clip's source span, return the
   * absolute timeline frame range (so the AI can seek or ripple-cut it).
   */
  locateInTimeline(query: string, limit = 50): Array<{ clipId: string; trackIndex: number; startFrame: number; endFrame: number; text: string }> {
    const fps = this.project.fps;
    const out: Array<{ clipId: string; trackIndex: number; startFrame: number; endFrame: number; text: string }> = [];
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        const asset = this.project.assets.find((a) => a.id === clip.assetId);
        const segs = asset?.transcript?.segments;
        if (!segs?.length) continue;
        const hits = rankTranscript([asset!], query, 1000);
        const speed = clip.effects?.speed ?? 1;
        const inSec = clip.sourceInFrame / fps;
        const outSec = clip.sourceOutFrame / fps;
        for (const h of hits) {
          // Only matches that fall within this clip's source window.
          if (h.end <= inSec || h.start >= outSec) continue;
          const s = Math.max(h.start, inSec);
          const e = Math.min(h.end, outSec);
          // Source seconds → clip-local timeline frames → absolute timeline frames.
          const startFrame = clip.startFrame + Math.round(((s - inSec) / speed) * fps);
          const endFrame = clip.startFrame + Math.round(((e - inSec) / speed) * fps);
          if (endFrame > startFrame) out.push({ clipId: clip.id, trackIndex: track.index, startFrame, endFrame, text: h.text });
        }
      }
    }
    out.sort((a, b) => a.startFrame - b.startFrame);
    return out.slice(0, limit);
  }

  /**
   * Build (and cache) an asset's perceptual visual fingerprint. If a CLIP image
   * model is installed (AIVE_CLIP_VISION) each sample also gets a semantic
   * embedding; otherwise the perceptual fingerprint stands alone.
   */
  async indexVisual(assetId: string, count = 5): Promise<{ asset: MediaAsset; sampleCount: number; semantic: boolean }> {
    const asset = this.getAsset(assetId);
    if (!asset.hasVideo) throw new Error("Asset has no video to fingerprint");
    const sig = await buildSignature(asset.path, asset.duration, count);
    // Try to bring up the CLIP model (downloads once); if usable, add semantic
    // embeddings to each sample so this asset is text- and image-searchable.
    const semantic = await ensureClip();
    if (semantic) {
      for (const sample of sig.samples) {
        const embed = await embedImage(asset.path, sample.t);
        if (embed) sample.embed = embed;
      }
    }
    const updated = this.mutate(() => {
      this.getAsset(assetId).visualSig = sig;
      return this.getAsset(assetId);
    });
    return { asset: updated, sampleCount: sig.samples.length, semantic };
  }

  /**
   * Find shots by appearance/meaning. Two reference modes:
   *   - TEXT query ("the wide shot of the sunset") → semantic text→image ranking
   *     (requires the CLIP model; if it's unavailable this throws a clear error).
   *   - a reference FRAME (clipId or assetId + atSeconds) → ranks by perceptual
   *     similarity, blended with CLIP image↔image when the model is present.
   * Auto-indexes any candidate asset that hasn't been fingerprinted yet.
   */
  async searchVisual(
    ref: { query?: string; clipId?: string; assetId?: string; atSeconds?: number },
    limit = 12,
  ): Promise<{ semantic: boolean; mode: "text" | "reference"; hits: Array<{ assetId: string; name: string; score: number; atSeconds: number }> }> {
    const fps = this.project.fps;

    // ----- TEXT-QUERY (semantic) mode -----
    if (ref.query && ref.query.trim()) {
      await ensureClip();
      const qVec = await embedText(ref.query.trim());
      if (!qVec) {
        throw new Error(
          "Semantic text search needs the local CLIP model, which isn't installed/available. " +
            "Index an asset first (downloads it once) or use a reference frame (clipId/assetId) instead.",
        );
      }
      const hits: Array<{ assetId: string; name: string; score: number; atSeconds: number }> = [];
      for (const asset of this.project.assets) {
        if (!asset.hasVideo) continue;
        let sig = asset.visualSig as VisualSignature | undefined;
        if (!sig || !sig.samples.some((s) => s.embed)) {
          await this.indexVisual(asset.id);
          sig = this.getAsset(asset.id).visualSig as VisualSignature;
        }
        let best = -1;
        let bestT = 0;
        for (const s of sig.samples) {
          const sc = cosine(qVec, s.embed);
          if (sc > best) { best = sc; bestT = s.t; }
        }
        if (best > -1) hits.push({ assetId: asset.id, name: asset.name, score: Number(best.toFixed(4)), atSeconds: Number(bestT.toFixed(2)) });
      }
      hits.sort((a, b) => b.score - a.score);
      return { semantic: true, mode: "text", hits: hits.slice(0, limit) };
    }

    // ----- REFERENCE-FRAME mode -----
    let refAssetId: string;
    let refSrcSec: number;
    if (ref.clipId) {
      const { clip } = this.findClip(ref.clipId);
      refAssetId = clip.assetId;
      const speed = clip.effects?.speed ?? 1;
      const local = Math.max(0, ref.atSeconds ?? 0);
      refSrcSec = clip.sourceInFrame / fps + local * speed;
    } else if (ref.assetId) {
      refAssetId = ref.assetId;
      refSrcSec = Math.max(0, ref.atSeconds ?? 0);
    } else {
      throw new Error("searchVisual needs a text `query` or a reference clipId/assetId");
    }
    const refAsset = this.getAsset(refAssetId);
    const refSample = await buildReferenceSample(refAsset.path, Math.min(refSrcSec, Math.max(0, refAsset.duration - 0.1)));
    const semantic = await ensureClip();
    if (semantic) {
      const e = await embedImage(refAsset.path, refSample.t);
      if (e) refSample.embed = e;
    }
    const refSig: VisualSignature = { samples: [refSample], bins: refSample.hist.length / 3 };

    const hits: Array<{ assetId: string; name: string; score: number; atSeconds: number }> = [];
    for (const asset of this.project.assets) {
      if (!asset.hasVideo) continue;
      let sig = asset.visualSig as VisualSignature | undefined;
      if (!sig) {
        await this.indexVisual(asset.id);
        sig = this.getAsset(asset.id).visualSig as VisualSignature;
      }
      let best = 0;
      let bestT = 0;
      for (const s of sig.samples) {
        const sc = signatureSimilarity(refSig, { samples: [s], bins: sig.bins });
        if (sc > best) { best = sc; bestT = s.t; }
      }
      hits.push({ assetId: asset.id, name: asset.name, score: Number(best.toFixed(4)), atSeconds: Number(bestT.toFixed(2)) });
    }
    hits.sort((a, b) => b.score - a.score);
    return { semantic, mode: "reference", hits: hits.slice(0, limit) };
  }

  /**
   * Align a clip to a reference clip by SOUND (cross-correlation of their audio
   * envelopes). Returns the measured offset; when `apply` is set, repositions
   * the clip on the timeline so its sound lines up with the reference.
   */
  async syncAudio(
    clipId: string,
    referenceClipId: string,
    apply = true,
  ): Promise<{ offsetSeconds: number; offsetFrames: number; confidence: number; applied: boolean }> {
    const fps = this.project.fps;
    const { clip } = this.findClip(clipId);
    const { clip: ref } = this.findClip(referenceClipId);
    const clipAsset = this.getAsset(clip.assetId);
    const refAsset = this.getAsset(ref.assetId);

    const result: AudioSyncResult = await findAudioOffset(refAsset.path, clipAsset.path);
    const offsetFrames = Math.round(result.offsetSeconds * fps);

    let applied = false;
    if (apply) {
      // offsetFrames > 0 means the clip's sound lags the reference, so shift the
      // clip EARLIER (relative to the reference's placement) to line them up.
      const newStart = Math.max(0, ref.startFrame - offsetFrames);
      this.moveClip(clipId, newStart);
      applied = true;
    }
    return { offsetSeconds: Number(result.offsetSeconds.toFixed(3)), offsetFrames, confidence: Number(result.confidence.toFixed(3)), applied };
  }

  /**
   * Merge a 2D transform (and/or static opacity) into a clip. `transform` is
   * deep-merged so you can nudge one field (e.g. just scale) at a time. Position
   * x/y are fractions of the canvas; scale is a multiplier (1 = fit); rotation is
   * degrees clockwise; opacity is 0..1.
   */
  setClipTransform(clipId: string, patch: { transform?: Transform; opacity?: number }): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const effects = clip.effects ?? (clip.effects = {});
      if (patch.transform) {
        const cur = effects.transform ?? {};
        const next: Transform = { ...cur, ...patch.transform };
        if (next.scale !== undefined) next.scale = clamp(next.scale, 0.01, 16);
        effects.transform = next;
      }
      if (patch.opacity !== undefined) effects.opacity = clamp(patch.opacity, 0, 1);
      return clip;
    });
  }

  /**
   * Set (replace) a clip's keyframe track for one animatable property
   * (x/y/scale/rotation/opacity/volume). Frames are clip-local (0 = clip start).
   * An empty list clears the track. Keyframes are kept sorted by frame.
   */
  setKeyframes(clipId: string, property: KeyframeProperty, keyframes: Keyframe[]): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const kf = clip.keyframes ?? (clip.keyframes = {});
      if (!keyframes.length) {
        delete kf[property];
      } else {
        kf[property] = sortKeyframes(
          keyframes.map((k) => ({ frame: Math.max(0, Math.round(k.frame)), value: k.value, ease: k.ease })),
        );
      }
      if (Object.keys(clip.keyframes).length === 0) delete clip.keyframes;
      return clip;
    });
  }

  /** Remove one keyframe track, or all of them when `property` is omitted. */
  clearKeyframes(clipId: string, property?: KeyframeProperty): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      if (!clip.keyframes) return;
      if (property) delete clip.keyframes[property];
      else delete clip.keyframes;
      if (clip.keyframes && Object.keys(clip.keyframes).length === 0) delete clip.keyframes;
    });
  }

  setProjectSettings(settings: { name?: string; width?: number; height?: number; fps?: number }): void {
    this.mutate(() => {
      if (settings.name !== undefined) this.project.name = settings.name;
      if (settings.width !== undefined) {
        this.project.width = settings.width;
        this.canvasAdopted = true;
      }
      if (settings.height !== undefined) {
        this.project.height = settings.height;
        this.canvasAdopted = true;
      }
      if (settings.fps !== undefined && settings.fps > 0 && settings.fps !== this.project.fps) {
        this.rescaleToFps(settings.fps);
      }
    });
  }

  /** Replace the timeline markers (frames). Deduped, sorted, non-negative integers. */
  setMarkers(frames: number[]): void {
    this.mutate(() => {
      const clean = [...new Set(frames.map((f) => Math.max(0, Math.round(f))))].sort((a, b) => a - b);
      if (clean.length) this.project.markers = clean;
      else delete this.project.markers;
    });
  }

  /** Rescale all frame counts when the project fps changes, preserving timing. */
  private rescaleToFps(newFps: number): void {
    const ratio = newFps / this.project.fps;
    const sc = (f: number) => Math.round(f * ratio);
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        clip.startFrame = sc(clip.startFrame);
        clip.sourceInFrame = sc(clip.sourceInFrame);
        clip.sourceOutFrame = sc(clip.sourceOutFrame);
        if (clip.audioOffsetFrames) clip.audioOffsetFrames = sc(clip.audioOffsetFrames);
        if (clip.transition) clip.transition.durationFrames = Math.max(1, sc(clip.transition.durationFrames));
        if (clip.effects?.fadeInFrames) clip.effects.fadeInFrames = sc(clip.effects.fadeInFrames);
        if (clip.effects?.fadeOutFrames) clip.effects.fadeOutFrames = sc(clip.effects.fadeOutFrames);
        for (const ov of clip.overlays ?? []) {
          if (ov.startFrame !== undefined) ov.startFrame = sc(ov.startFrame);
          if (ov.endFrame !== undefined) ov.endFrame = sc(ov.endFrame);
        }
        for (const cue of clip.captions?.cues ?? []) {
          cue.startFrame = sc(cue.startFrame);
          cue.endFrame = sc(cue.endFrame);
        }
        for (const g of clip.graphics ?? []) {
          if (g.startFrame !== undefined) g.startFrame = sc(g.startFrame);
          if (g.endFrame !== undefined) g.endFrame = sc(g.endFrame);
        }
      }
    }
    if (this.project.music) {
      if (this.project.music.fadeInFrames) this.project.music.fadeInFrames = sc(this.project.music.fadeInFrames);
      if (this.project.music.fadeOutFrames) this.project.music.fadeOutFrames = sc(this.project.music.fadeOutFrames);
    }
    if (this.project.markers) this.project.markers = this.project.markers.map(sc);
    this.project.fps = newFps;
  }

  // ---- rendering -------------------------------------------------------------
  /** Every clip across every track, with its owning track. */
  private allClips(): { track: Track; clip: Clip }[] {
    const out: { track: Track; clip: Clip }[] = [];
    for (const track of this.project.tracks) for (const clip of track.clips) out.push({ track, clip });
    return out;
  }

  private clipCount(): number {
    return this.project.tracks.reduce((n, t) => n + t.clips.length, 0);
  }

  /**
   * Resolve the timeline into render-ready clips (in seconds, absolute on the
   * timeline) AND stage any files the filtergraph needs by bare name (LUTs,
   * overlay text files, fonts). Renders run with cwd = that directory.
   */
  private async stageRender(): Promise<{ clips: ResolvedRenderClip[]; cwd: string }> {
    const work = join(this.dataDir, "render");
    await mkdir(work, { recursive: true });
    const fps = this.project.fps;
    const all = this.allClips();

    const needsFont = all.some(
      ({ clip }) => (clip.overlays?.length ?? 0) > 0 || (clip.captions?.cues.length ?? 0) > 0,
    );
    const defaultFont = needsFont ? await this.stageFont(work) : "";
    const fontCache = new Map<string, string>();

    const lutMap = new Map<string, string>();
    let lutIdx = 0;
    const resolved: ResolvedRenderClip[] = [];

    for (const { track, clip } of all) {
      const asset = this.getAsset(clip.assetId);
      const f2s = (f: number) => framesToSeconds(f, fps);

      let effects: ResolvedEffects | undefined;
      if (clip.effects || clip.keyframes) {
        const e = clip.effects ?? {};
        let keyframes: ResolvedEffects["keyframes"];
        if (clip.keyframes) {
          keyframes = {};
          for (const [prop, kfs] of Object.entries(clip.keyframes)) {
            if (!kfs?.length) continue;
            keyframes[prop as KeyframeProperty] = kfs.map(
              (k): ResolvedKeyframe => ({ sec: f2s(k.frame), value: k.value, ease: k.ease }),
            );
          }
        }
        effects = {
          speed: e.speed,
          volume: e.volume,
          fadeIn: e.fadeInFrames ? f2s(e.fadeInFrames) : undefined,
          fadeOut: e.fadeOutFrames ? f2s(e.fadeOutFrames) : undefined,
          color: e.color,
          grade: e.grade,
          lut: e.lut,
          filters: e.filters,
          crop: e.crop,
          transform: e.transform,
          opacity: e.opacity,
          keyframes,
        };
        if (effects.lut) {
          let name = lutMap.get(effects.lut);
          if (!name) {
            name = `lut${lutIdx++}.cube`;
            await copyFile(effects.lut, join(work, name));
            lutMap.set(effects.lut, name);
          }
          effects = { ...effects, lut: name };
        }
      }

      let overlays: ResolvedOverlay[] | undefined;
      if (clip.overlays?.length) {
        overlays = [];
        for (const ov of clip.overlays) {
          const textFile = `txt_${ov.id}.txt`;
          await writeFile(join(work, textFile), ov.text, "utf8");
          const d = defaultTextStyle(this.project.height, ov.fontSize);
          overlays.push({
            textFile,
            fontFile: await this.resolveFont(work, ov.font, fontCache, defaultFont),
            fontSize: d.fontSize,
            color: ov.color ?? "white",
            box: ov.box ?? false,
            boxColor: ov.boxColor ?? "black@0.55",
            boxBorderW: ov.boxBorderW ?? d.boxBorderW,
            outlineColor: ov.outlineColor ?? "black",
            outlineWidth: ov.outlineWidth ?? d.outlineWidth,
            shadowColor: ov.shadowColor ?? "black@0.5",
            shadowX: ov.shadowX ?? 0,
            shadowY: ov.shadowY ?? d.shadowY,
            position: ov.position ?? "bottom",
            x: ov.x,
            y: ov.y,
            start: ov.startFrame !== undefined ? f2s(ov.startFrame) : undefined,
            end: ov.endFrame !== undefined ? f2s(ov.endFrame) : undefined,
            keyframes: ov.keyframes ? resolveOverlayKeyframes(ov.keyframes, f2s) : undefined,
          });
        }
      }

      if (clip.captions?.cues.length) {
        overlays ??= [];
        const st = clip.captions.style ?? {};
        const capFont = await this.resolveFont(work, st.font, fontCache, defaultFont);
        for (let i = 0; i < clip.captions.cues.length; i++) {
          const cue = clip.captions.cues[i];
          const textFile = `cap_${clip.id}_${i}.txt`;
          await writeFile(join(work, textFile), cue.text, "utf8");
          const d = defaultTextStyle(this.project.height, st.fontSize);
          overlays.push({
            textFile,
            fontFile: capFont,
            fontSize: d.fontSize,
            // Captions default to bright yellow on a translucent rounded box — a
            // classic, highly-readable subtitle look (overlays/titles stay white,
            // no box). Any explicit caption style still overrides this.
            color: st.color ?? "#ffe14d",
            box: st.box ?? true,
            boxColor: st.boxColor ?? "black@0.55",
            boxBorderW: st.boxBorderW ?? d.boxBorderW,
            outlineColor: st.outlineColor ?? "black",
            outlineWidth: st.outlineWidth ?? d.outlineWidth,
            shadowColor: st.shadowColor ?? "black@0.5",
            shadowX: st.shadowX ?? 0,
            shadowY: st.shadowY ?? d.shadowY,
            position: st.position ?? "bottom",
            x: st.x,
            y: st.y,
            start: f2s(cue.startFrame),
            end: f2s(cue.endFrame),
          });
        }
      }

      let graphics: ResolvedGraphic[] | undefined;
      if (clip.graphics?.length) {
        graphics = [];
        for (const g of clip.graphics) {
          const gAsset = this.project.assets.find((a) => a.id === g.assetId);
          if (!gAsset) continue;
          graphics.push({
            path: gAsset.path,
            start: g.startFrame !== undefined ? f2s(g.startFrame) : undefined,
            end: g.endFrame !== undefined ? f2s(g.endFrame) : undefined,
            opacity: g.opacity,
          });
        }
        if (graphics.length === 0) graphics = undefined;
      }

      resolved.push({
        path: asset.path,
        trackIndex: track.index,
        showVideo: track.kind === "video" && !track.hidden,
        startSec: f2s(clip.startFrame),
        sourceIn: f2s(clip.sourceInFrame),
        sourceSpan: f2s(clip.sourceOutFrame - clip.sourceInFrame),
        outDuration: framesToSeconds(clipDurationFrames(clip), fps),
        isImage: asset.isImage,
        hasAudio: asset.hasAudio,
        muted: !!track.muted,
        trackVolume: track.volume,
        effects,
        transition: clip.transition
          ? { type: clip.transition.type, duration: f2s(clip.transition.durationFrames) }
          : undefined,
        overlays,
        graphics,
        audioOffset: clip.audioOffsetFrames ? f2s(clip.audioOffsetFrames) : undefined,
      });
    }

    return { clips: resolved, cwd: work };
  }

  private async resolveFont(
    work: string,
    spec: string | undefined,
    cache: Map<string, string>,
    defaultBare: string,
  ): Promise<string> {
    const key = spec?.trim() || "__default__";
    const cached = cache.get(key);
    if (cached) return cached;

    let srcPath: string | undefined;
    if (spec?.trim()) {
      const s = spec.trim();
      if (isAbsolute(s) && (await fileExists(s))) srcPath = s;
      else srcPath = await findSystemFont(s);
    }
    if (!srcPath) {
      cache.set(key, defaultBare);
      return defaultBare;
    }

    const bare = `font_${cache.size}${srcPath.toLowerCase().endsWith(".otf") ? ".otf" : ".ttf"}`;
    try {
      await copyFile(srcPath, join(work, bare));
      cache.set(key, bare);
      return bare;
    } catch {
      cache.set(key, defaultBare);
      return defaultBare;
    }
  }

  /** Copy a usable font into the render dir as font.ttf. */
  private async stageFont(work: string): Promise<string> {
    const dest = join(work, "font.ttf");
    const candidates = [
      ...(process.env.AIVE_FONT ? [process.env.AIVE_FONT] : []),
      "C:/Windows/Fonts/arial.ttf",
      "C:/Windows/Fonts/segoeui.ttf",
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/Library/Fonts/Arial.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ];
    for (const c of candidates) {
      try {
        await copyFile(c, dest);
        return "font.ttf";
      } catch {
        /* try next */
      }
    }
    throw new Error(
      "No system font found for text overlays. Place a .ttf at <dataDir>/render/font.ttf and retry.",
    );
  }

  get canvas(): Canvas {
    return { width: this.project.width, height: this.project.height, fps: this.project.fps };
  }

  /** Total timeline length in frames (the furthest clip end across all tracks). */
  timelineDurationFrames(): number {
    let total = 0;
    for (const { clip } of this.allClips()) total = Math.max(total, clipEndFrame(clip));
    return total;
  }

  /** Total timeline duration in seconds. */
  timelineDuration(): number {
    return framesToSeconds(this.timelineDurationFrames(), this.project.fps);
  }

  /**
   * Set or update the transition entering a clip from the previous clip on the
   * same track. The clip (and everything after it on that track) is pulled left
   * to overlap the previous clip by `durationFrames` (overlap-based crossfade).
   */
  setTransition(clipId: string, type: TransitionType, durationFrames: number): Clip {
    return this.mutate(() => {
      const { track, clip } = this.findClip(clipId);
      EditorEngine.sortTrack(track);
      const idx = track.clips.findIndex((c) => c.id === clipId);
      if (idx <= 0) throw new Error("The first clip on a track cannot have an entering transition");
      const prev = track.clips[idx - 1];
      const maxOverlap = Math.min(clipDurationFrames(prev), clipDurationFrames(clip)) - 1;
      const overlap = clamp(Math.round(durationFrames), 1, Math.max(1, maxOverlap));
      const desiredStart = clipEndFrame(prev) - overlap;
      const delta = desiredStart - clip.startFrame;
      const from = clip.startFrame;
      for (const c of track.clips) if (c.startFrame >= from) c.startFrame += delta;
      clip.transition = { type, durationFrames: overlap };
      EditorEngine.sortTrack(track);
      return clip;
    });
  }

  /** Remove the transition entering a clip, restoring it to butt against the previous clip. */
  removeTransition(clipId: string): void {
    this.mutate(() => {
      const { track, clip } = this.findClip(clipId);
      if (!clip.transition) return;
      EditorEngine.sortTrack(track);
      const idx = track.clips.findIndex((c) => c.id === clipId);
      const prev = idx > 0 ? track.clips[idx - 1] : undefined;
      const delta = prev ? clipEndFrame(prev) - clip.startFrame : 0;
      const from = clip.startFrame;
      for (const c of track.clips) if (c.startFrame >= from) c.startFrame += delta;
      delete clip.transition;
      EditorEngine.sortTrack(track);
    });
  }

  /** Slide a clip's audio relative to its video for a J/L cut (frames). */
  setClipAudioOffset(clipId: string, offsetFrames: number): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const o = clamp(Math.round(offsetFrames), -secondsToFrames(30, this.project.fps), secondsToFrames(30, this.project.fps));
      if (o === 0) delete clip.audioOffsetFrames;
      else clip.audioOffsetFrames = o;
      return clip;
    });
  }

  /** Add a burned-in text overlay (title / lower-third) to a clip. */
  addTextOverlay(clipId: string, overlay: Omit<TextOverlay, "id">): TextOverlay {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const ov: TextOverlay = { id: newId("text"), ...overlay };
      (clip.overlays ??= []).push(ov);
      return ov;
    });
  }

  removeTextOverlay(clipId: string, overlayId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      if (clip.overlays) {
        clip.overlays = clip.overlays.filter((o) => o.id !== overlayId);
        if (clip.overlays.length === 0) delete clip.overlays;
      }
    });
  }

  clearTextOverlays(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      delete clip.overlays;
    });
  }

  setTextStyle(clipId: string, overlayId: string | undefined, style: Partial<TextStyle>): TextOverlay[] {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      if (!clip.overlays?.length) throw new Error("This clip has no text overlays to style — add text first.");
      const targets = overlayId ? clip.overlays.filter((o) => o.id === overlayId) : clip.overlays;
      if (overlayId && targets.length === 0) throw new Error(`No text overlay ${overlayId} on this clip.`);
      for (const o of targets) {
        Object.assign(o, style);
        // A keyword `position` and explicit x/y are mutually exclusive intents:
        // the renderer prefers x/y when present, so a stale x/y would silently
        // override a freshly-picked keyword. Clear them so the keyword takes.
        if (typeof style.position === "string" && style.position) { delete o.x; delete o.y; }
      }
      return targets;
    });
  }

  /**
   * Keyframe-animate a text overlay's position or opacity (native animated
   * titles — fly-ins, slides, fades — no code). REPLACES that property's track;
   * pass an empty list to clear it. `frame` is CLIP-LOCAL (0 = clip start),
   * x/y are canvas fractions, opacity 0..1.
   */
  animateText(clipId: string, overlayId: string, property: TextAnimProperty, keyframes: Keyframe[]): TextOverlay {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const overlay = clip.overlays?.find((o) => o.id === overlayId);
      if (!overlay) throw new Error(`No text overlay ${overlayId} on this clip.`);
      const tracks = overlay.keyframes ?? (overlay.keyframes = {});
      if (keyframes.length === 0) {
        delete tracks[property];
        if (Object.keys(tracks).length === 0) delete overlay.keyframes;
      } else {
        tracks[property] = sortKeyframes(keyframes.map((k) => ({ frame: Math.max(0, Math.round(k.frame)), value: k.value, ease: k.ease })));
      }
      return overlay;
    });
  }

  // ---- captions (Whisper) ----------------------------------------------------
  /**
   * Transcribe a clip's audio with whisper.cpp (local, offline) and attach the
   * result as a caption track. Cue times (source seconds) are converted to
   * clip-local frames (speed-adjusted).
   */
  async generateCaptions(
    clipId: string,
    opts: { model?: WhisperModel; language?: string; maxLen?: number; style?: CaptionStyle } = {},
  ): Promise<{ clip: Clip; cueCount: number }> {
    const { clip } = this.findClip(clipId);
    const asset = this.getAsset(clip.assetId);
    if (!asset.hasAudio) throw new Error("Clip's source has no audio to transcribe");

    const fps = this.project.fps;
    const sourceInSec = framesToSeconds(clip.sourceInFrame, fps);
    const spanSec = framesToSeconds(clip.sourceOutFrame - clip.sourceInFrame, fps);
    const speed = clip.effects?.speed ?? 1;
    const durFrames = clipDurationFrames(clip);

    const dir = join(this.dataDir, "captions");
    await mkdir(dir, { recursive: true });
    const wav = join(dir, `${clipId}.wav`);

    await runFfmpeg([
      "-hide_banner",
      "-ss",
      sourceInSec.toFixed(6),
      "-t",
      spanSec.toFixed(6),
      "-i",
      asset.path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      wav,
    ]);

    const model = opts.model ?? DEFAULT_MODEL;
    const cues: TranscriptCue[] = await transcribe(wav, { model, language: opts.language, maxLen: opts.maxLen });

    // Source-span seconds -> clip-local frames (speed-adjusted), clamped.
    const localCues = cues
      .map((c) => ({
        startFrame: clamp(secondsToFrames(c.start / speed, fps), 0, durFrames),
        endFrame: clamp(secondsToFrames(c.end / speed, fps), 0, durFrames),
        text: c.text,
      }))
      .filter((c) => c.endFrame > c.startFrame);

    const captions: Captions = { cues: localCues, style: opts.style, model, language: opts.language ?? "en" };

    const updated = this.mutate(() => {
      const { clip: target } = this.findClip(clipId);
      target.captions = captions;
      return target;
    });
    return { clip: updated, cueCount: localCues.length };
  }

  clearCaptions(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      delete clip.captions;
    });
  }

  setCaptionStyle(clipId: string, style: Record<string, unknown>): Clip {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const caps = clip.captions;
      if (!caps) throw new Error("This clip has no captions to style — generate captions first.");
      caps.style = { ...(caps.style ?? {}), ...style } as typeof caps.style;
      // A keyword `position` overrides any prior free x/y placement (the renderer
      // prefers x/y when present), so clear them when a keyword position is set.
      if (typeof style.position === "string" && style.position && caps.style) {
        delete (caps.style as Record<string, unknown>).x;
        delete (caps.style as Record<string, unknown>).y;
      }
      return clip;
    });
  }

  /**
   * Render a fast, lower-resolution preview of the whole timeline. Cancels any
   * in-flight preview render. Returns the output file path.
   */
  async renderPreview(): Promise<RenderResult> {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to preview");

    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    const dir = join(this.dataDir, "previews");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `preview-${this.project.revision}-${Date.now()}.mp4`);

    const canvas = previewCanvas(this.canvas);
    const { clips: staged, cwd } = await this.stageRender();
    const { args, totalDuration } = buildRenderCommand(staged, canvas, outPath, PREVIEW_PROFILE, this.resolveMusic());

    await runFfmpeg(args, {
      cwd,
      totalDuration,
      signal: abort.signal,
      onProgress: (fraction) => this.emit("progress", { job: "preview", fraction }),
    });

    this.previewCache = { revision: this.project.revision, path: outPath };
    return { path: outPath, duration: totalDuration };
  }

  /**
   * Render a single composited frame of the whole timeline at `atSeconds` and
   * return its PNG path. Reuses a cached full preview when the edit is unchanged.
   */
  async renderFrame(atSeconds?: number): Promise<string> {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to show");

    let preview = this.previewCache;
    const fresh = preview && preview.revision === this.project.revision && (await fileExists(preview.path));
    if (!fresh) {
      const r = await this.renderPreview();
      preview = { revision: this.project.revision, path: r.path };
    }

    const total = this.timelineDuration();
    const t = Math.min(Math.max(0, atSeconds ?? total / 2), Math.max(0, total - 0.05));
    const dir = join(this.dataDir, "frames");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `frame-${Date.now()}.png`);
    await runFfmpeg(["-hide_banner", "-ss", t.toFixed(3), "-i", preview!.path, "-frames:v", "1", "-y", outPath]);
    return outPath;
  }

  /** Render the final export to `outputPath` with optional encoding settings. */
  async exportVideo(outputPath: string, settings?: ExportSettings): Promise<RenderResult> {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to export");

    await mkdir(dirname(outputPath), { recursive: true });
    const { clips: staged, cwd } = await this.stageRender();
    const { args, totalDuration } = buildRenderCommand(staged, this.canvas, outputPath, EXPORT_PROFILE, this.resolveMusic(), settings);

    await runFfmpeg(args, {
      cwd,
      totalDuration,
      onProgress: (fraction) => this.emit("progress", { job: "export", fraction }),
    });

    return { path: outputPath, duration: totalDuration };
  }

  /** Generate a thumbnail JPEG for an asset at the given time. Returns its path. */
  async generateThumbnail(assetId: string, atSeconds = 0): Promise<string> {
    const asset = this.getAsset(assetId);
    const dir = join(this.dataDir, "thumbnails");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `${assetId}.jpg`);
    const time = Math.min(Math.max(0, atSeconds), Math.max(0, asset.duration - 0.1));
    await runFfmpeg(buildThumbnailCommand(asset.path, time, outPath));
    return outPath;
  }

  /** Re-point a clip (and any link group) at a freshly baked asset spanning it whole. */
  private repointClip(clipId: string, baked: MediaAsset): Clip {
    const fps = this.project.fps;
    const frames = Math.max(MIN_CLIP_FRAMES, Math.round(baked.duration * fps));
    const { clip: target } = this.findClip(clipId);
    target.assetId = baked.id;
    target.sourceInFrame = 0;
    target.sourceOutFrame = frames;
    return target;
  }

  /**
   * Stabilize a clip's footage (two-pass vidstab), bake it, and re-point the
   * clip at the result. Other effects and any transition are preserved.
   */
  async stabilizeClip(clipId: string): Promise<Clip> {
    const { clip } = this.findClip(clipId);
    const asset = this.getAsset(clip.assetId);
    const fps = this.project.fps;
    const sourceInSec = framesToSeconds(clip.sourceInFrame, fps);
    const spanSec = framesToSeconds(clip.sourceOutFrame - clip.sourceInFrame, fps);

    const dir = join(this.dataDir, "baked");
    await mkdir(dir, { recursive: true });
    const trfName = `${clipId}.trf`;
    const outName = `${clipId}-stab.mp4`;
    const outPath = join(dir, outName);

    await runFfmpeg(
      [
        "-hide_banner",
        "-ss",
        sourceInSec.toFixed(6),
        "-t",
        spanSec.toFixed(6),
        "-i",
        asset.path,
        "-vf",
        `vidstabdetect=shakiness=6:accuracy=15:result=${trfName}`,
        "-f",
        "null",
        "-",
      ],
      { cwd: dir },
    );

    const pass2: string[] = [
      "-hide_banner",
      "-ss",
      sourceInSec.toFixed(6),
      "-t",
      spanSec.toFixed(6),
      "-i",
      asset.path,
      "-vf",
      `vidstabtransform=input=${trfName}:smoothing=30:zoom=0,unsharp=5:5:0.8:3:3:0.4`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
    ];
    if (asset.hasAudio) pass2.push("-c:a", "aac", "-b:a", "192k");
    else pass2.push("-an");
    pass2.push("-movflags", "+faststart", "-y", outName);
    await runFfmpeg(pass2, { cwd: dir });

    const baked = await probeAsset(outPath);
    baked.name = `${asset.name} (stabilized)`;

    return this.mutate(() => {
      this.project.assets.push(baked);
      return this.repointClip(clipId, baked);
    });
  }

  /**
   * Subject-tracking auto-reframe (YuNet, local). Bakes a moving crop at the
   * project's output aspect and re-points the clip at the result. Set the
   * project to the target aspect before calling.
   */
  async autoReframe(
    clipId: string,
    opts: { sampleFps?: number; smoothing?: number; scoreThreshold?: number } = {},
  ): Promise<{ clip: Clip; hitRate: number; cropWidth: number; cropHeight: number; keyframes: number }> {
    const { clip } = this.findClip(clipId);
    const asset = this.getAsset(clip.assetId);
    if (!asset.hasVideo || asset.width <= 0 || asset.height <= 0) {
      throw new Error("Auto-reframe needs a clip with a decodable video stream");
    }

    const fps = this.project.fps;
    const srcW = asset.width;
    const srcH = asset.height;
    const outW = even(this.project.width);
    const outH = even(this.project.height);
    const targetAR = outW / outH;
    const srcAR = srcW / srcH;

    let cropW: number;
    let cropH: number;
    if (targetAR <= srcAR) {
      cropH = srcH;
      cropW = Math.round(cropH * targetAR);
    } else {
      cropW = srcW;
      cropH = Math.round(cropW / targetAR);
    }
    cropW = Math.min(srcW, even(cropW));
    cropH = Math.min(srcH, even(cropH));

    const sourceInSec = framesToSeconds(clip.sourceInFrame, fps);
    const spanSec = framesToSeconds(clip.sourceOutFrame - clip.sourceInFrame, fps);

    const { samples, hitRate } = await trackSubject({
      path: asset.path,
      sourceIn: sourceInSec,
      span: spanSec,
      srcW,
      srcH,
      sampleFps: opts.sampleFps,
      scoreThreshold: opts.scoreThreshold,
    });
    const keys = buildCropPlan(samples, { srcW, srcH, cropW, cropH, smoothing: opts.smoothing });

    const dir = join(this.dataDir, "baked");
    await mkdir(dir, { recursive: true });
    const cmdName = `${clipId}-reframe.txt`;
    const outName = `${clipId}-reframe.mp4`;
    const outPath = join(dir, outName);
    await writeFile(join(dir, cmdName), cropPlanToSendcmd(keys), "utf8");

    const vf =
      `sendcmd=f=${cmdName},` +
      `crop=${cropW}:${cropH}:${keys[0].x}:${keys[0].y},` +
      `scale=${outW}:${outH},setsar=1,format=yuv420p`;

    const bake: string[] = [
      "-hide_banner",
      "-ss",
      sourceInSec.toFixed(6),
      "-t",
      spanSec.toFixed(6),
      "-i",
      asset.path,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
    ];
    if (asset.hasAudio) bake.push("-c:a", "aac", "-b:a", "192k");
    else bake.push("-an");
    bake.push("-movflags", "+faststart", "-y", outName);
    await runFfmpeg(bake, { cwd: dir });

    const baked = await probeAsset(outPath);
    baked.name = `${asset.name} (reframed ${outW}x${outH})`;

    const updated = this.mutate(() => {
      this.project.assets.push(baked);
      const target = this.repointClip(clipId, baked);
      // The crop is baked in now — drop any manual crop effect.
      if (target.effects?.crop) {
        const { crop, ...rest } = target.effects;
        target.effects = rest;
      }
      return target;
    });

    return { clip: updated, hitRate, cropWidth: cropW, cropHeight: cropH, keyframes: keys.length };
  }

  // ---- motion graphics (Remotion) -------------------------------------------
  /**
   * Render an AI-authored Remotion component (TSX) to a baked alpha video and
   * attach it to a clip as a motion-graphic overlay, OR (standalone / no clip)
   * insert it as its own clip. Frame windows are in project frames.
   */
  async addGraphic(
    clipId: string | undefined,
    opts: {
      code: string;
      props?: Record<string, unknown>;
      durationSeconds?: number;
      startFrame?: number;
      endFrame?: number;
      opacity?: number;
      standalone?: boolean;
    },
  ): Promise<{ graphic?: GraphicOverlay; clip: Clip; asset: MediaAsset }> {
    const clip = clipId ? this.findClip(clipId).clip : undefined;
    const asNewClip = !clipId || !!opts.standalone;

    const fps = this.project.fps;
    const width = even(this.project.width);
    const height = even(this.project.height);

    const startFrame = Math.max(0, Math.round(opts.startFrame ?? 0));
    let durationSeconds =
      opts.durationSeconds ??
      (opts.endFrame !== undefined
        ? framesToSeconds(opts.endFrame - startFrame, fps)
        : clip
          ? Math.max(framesToSeconds(MIN_CLIP_FRAMES, fps), this.clipDuration(clip) - framesToSeconds(startFrame, fps))
          : 5);
    durationSeconds = clamp(durationSeconds, 0.1, 600);
    const durationInFrames = Math.max(1, Math.round(durationSeconds * fps));
    const endFrame = opts.endFrame ?? startFrame + durationInFrames;

    const id = newId("gfx");
    const bakedDir = join(this.dataDir, "baked");
    await mkdir(bakedDir, { recursive: true });
    const outPath = join(bakedDir, `${id}-graphic.${asNewClip ? "mp4" : "mov"}`);
    const workDir = join(this.dataDir, "motion", id);

    await renderGraphic({
      code: opts.code,
      props: opts.props,
      width,
      height,
      fps,
      durationInFrames,
      outPath,
      alpha: !asNewClip,
      workDir,
    });

    const baked = await probeAsset(outPath);
    baked.name = `Motion graphic (${width}x${height})`;

    // Overlay graphics are ProRes-4444 .mov (alpha) — which browsers can't
    // decode — so the live Canvas2D preview can't show them. Transcode a small
    // VP8/alpha .webm proxy (Chromium plays it, drawImage keeps the alpha) so
    // the graphic previews live; the EXPORT still composites the full .mov.
    if (!asNewClip) {
      const webmPath = join(bakedDir, `${id}-graphic.webm`);
      try {
        await runFfmpeg([
          "-hide_banner", "-y", "-i", outPath,
          "-c:v", "libvpx", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
          "-b:v", "3M", "-deadline", "realtime", "-cpu-used", "5", "-an", webmPath,
        ]);
        baked.previewPath = webmPath;
      } catch {
        // Preview proxy is best-effort: if VP8/alpha isn't available the graphic
        // still renders in export and "Render exact"; preview just omits it.
      }
    }

    return this.mutate(() => {
      this.project.assets.push(baked);
      if (asNewClip) {
        const bakedFrames = Math.max(MIN_CLIP_FRAMES, Math.round(baked.duration * fps));
        if (clipId) {
          // Insert right after the target clip on its track.
          const { track, clip: target } = this.findClip(clipId);
          const gclip = this.makeClip(baked.id, clipEndFrame(target), 0, bakedFrames);
          track.clips.push(gclip);
          EditorEngine.sortTrack(track);
          return { clip: gclip, asset: baked };
        }
        const gclip = this.placeClip(baked.id, { sourceInFrame: 0, sourceOutFrame: bakedFrames });
        return { clip: gclip, asset: baked };
      }
      const { clip: target } = this.findClip(clipId!);
      const graphic: GraphicOverlay = {
        id,
        assetId: baked.id,
        startFrame,
        endFrame,
        opacity: opts.opacity,
        code: opts.code,
        props: opts.props,
      };
      (target.graphics ??= []).push(graphic);
      return { graphic, clip: target, asset: baked };
    });
  }

  removeGraphic(clipId: string, graphicId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      if (clip.graphics) {
        clip.graphics = clip.graphics.filter((g) => g.id !== graphicId);
        if (clip.graphics.length === 0) delete clip.graphics;
      }
    });
  }

  clearGraphics(clipId: string): void {
    this.mutate(() => {
      const { clip } = this.findClip(clipId);
      delete clip.graphics;
    });
  }

  // ---- timeline windows for overlays/captions/graphics ----------------------
  // These let the timeline UI (or the AI) move/resize an element's frame window
  // directly. Frames are CLIP-LOCAL (0 = the clip's start); they are clamped to
  // be ordered and non-negative.

  /** Move/resize a text overlay's show window (clip-local frames). */
  setTextWindow(clipId: string, overlayId: string, startFrame?: number, endFrame?: number): TextOverlay {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const ov = clip.overlays?.find((o) => o.id === overlayId);
      if (!ov) throw new Error(`No text overlay ${overlayId} on this clip.`);
      if (startFrame !== undefined) ov.startFrame = Math.max(0, Math.round(startFrame));
      if (endFrame !== undefined) ov.endFrame = Math.max((ov.startFrame ?? 0) + 1, Math.round(endFrame));
      return ov;
    });
  }

  /** Move/resize a motion-graphic's show window (clip-local frames). */
  setGraphicWindow(clipId: string, graphicId: string, startFrame?: number, endFrame?: number): GraphicOverlay {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const g = clip.graphics?.find((x) => x.id === graphicId);
      if (!g) throw new Error(`No motion graphic ${graphicId} on this clip.`);
      if (startFrame !== undefined) g.startFrame = Math.max(0, Math.round(startFrame));
      if (endFrame !== undefined) g.endFrame = Math.max((g.startFrame ?? 0) + 1, Math.round(endFrame));
      return g;
    });
  }

  /** Move/resize a single caption cue (clip-local frames) by its index. */
  setCaptionCue(clipId: string, index: number, startFrame?: number, endFrame?: number): CaptionCue {
    return this.mutate(() => {
      const { clip } = this.findClip(clipId);
      const cue = clip.captions?.cues[index];
      if (!cue) throw new Error(`No caption cue at index ${index} on this clip.`);
      if (startFrame !== undefined) cue.startFrame = Math.max(0, Math.round(startFrame));
      if (endFrame !== undefined) cue.endFrame = Math.max(cue.startFrame + 1, Math.round(endFrame));
      return cue;
    });
  }

  /**
   * Everything the AI needs to plan an edit / author & place a motion graphic on
   * a clip: the clip's timeline position + source range, its asset, the canvas,
   * what's already on the clip, AND a few SAMPLED composited frames (image paths)
   * so the model can SEE the footage and choose safe areas / exact placement.
   */
  async inspectClip(clipId: string, frameCount = 3): Promise<Record<string, unknown>> {
    const { track, clip } = this.findClip(clipId);
    const asset = this.getAsset(clip.assetId);
    const fps = this.project.fps;
    const durationFrames = clipDurationFrames(clip);
    const startSec = framesToSeconds(clip.startFrame, fps);
    const durSec = framesToSeconds(durationFrames, fps);

    const n = Math.max(1, Math.min(5, Math.round(frameCount)));
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : 0.04 + (i / (n - 1)) * 0.92; // avoid exact edges
      frames.push(await this.renderFrame(startSec + durSec * f));
    }

    return {
      clip: {
        id: clip.id,
        trackIndex: track.index,
        trackKind: track.kind,
        startFrame: clip.startFrame,
        durationFrames,
        endFrame: clip.startFrame + durationFrames,
        sourceInFrame: clip.sourceInFrame,
        sourceOutFrame: clip.sourceOutFrame,
      },
      asset: {
        id: asset.id,
        name: asset.name,
        isImage: !!asset.isImage,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.duration,
        hasAudio: asset.hasAudio,
      },
      canvas: { width: this.project.width, height: this.project.height, fps },
      elements: {
        overlays: (clip.overlays ?? []).map((o) => ({ id: o.id, text: o.text, startFrame: o.startFrame ?? 0, endFrame: o.endFrame ?? durationFrames })),
        captionCues: clip.captions?.cues.length ?? 0,
        captionStyle: clip.captions?.style ?? null,
        graphics: (clip.graphics ?? []).map((g) => ({ id: g.id, startFrame: g.startFrame ?? 0, endFrame: g.endFrame ?? durationFrames, props: g.props })),
        effects: clip.effects ?? {},
      },
      frames,
    };
  }

  // ---- analysis (AI "ears and eyes") ----------------------------------------
  async analyzeSilence(assetId: string, noiseDb?: number, minDur?: number): Promise<SilenceRange[]> {
    const asset = this.getAsset(assetId);
    return detectSilence(asset.path, noiseDb, minDur);
  }

  async analyzeScenes(assetId: string, threshold?: number): Promise<SceneCut[]> {
    const asset = this.getAsset(assetId);
    return detectScenes(asset.path, threshold);
  }

  // ---- persistence -----------------------------------------------------------
  /** The .aive file the open project lives in, or undefined if never saved. */
  getCurrentPath(): string | undefined {
    return this.currentPath;
  }

  /** True when the project has edits that haven't been written to disk yet. */
  isDirty(): boolean {
    return this.project.revision !== this.lastSavedRevision;
  }

  /** Is there anything worth saving? (An empty, never-touched project isn't.) */
  private hasContent(): boolean {
    return this.project.assets.length > 0 || this.project.tracks.some((t) => t.clips.length > 0);
  }

  /**
   * Persist the current project *before* it is discarded (by "new"/"open") if it
   * has unsaved edits worth keeping — so no work is ever silently lost, including
   * on the AI/MCP path which has no confirm dialog. Named projects re-save to
   * their own file; a never-saved project is written to a timestamped recovery
   * file under the data dir. Returns the path written, or null if nothing was due.
   */
  async autoSaveIfDirty(): Promise<string | null> {
    if (!this.isDirty() || !this.hasContent()) return null;
    const target =
      this.currentPath ??
      join(this.dataDir, "autosave", `Recovered-${new Date().toISOString().replace(/[:.]/g, "-")}.aive`);
    await this.save(target);
    return target;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // Give a still-"Untitled" project a meaningful name from its filename, so the
    // UI title and the AI both have a clear handle on which video this is.
    if (!this.project.name || this.project.name === "Untitled Project") {
      this.mutate(() => { this.project.name = basename(path).replace(/\.aive$/i, ""); });
    }
    await writeFile(path, JSON.stringify(this.project, null, 2), "utf8");
    this.currentPath = path;
    this.lastSavedRevision = this.project.revision;
    // Re-emit so clients pick up the new name / file path in the state envelope.
    this.emit("change", this.project);
  }

  async load(path: string): Promise<Project> {
    const raw = await readFile(path, "utf8");
    const loaded = JSON.parse(raw) as Project;
    if (!loaded.tracks || !Array.isArray(loaded.assets)) {
      throw new Error("File is not a valid .aive project");
    }
    this.undoStack = [];
    this.redoStack = [];
    this.project = migrateProject(loaded);
    this.canvasAdopted = true;
    this.currentPath = path;
    this.project.revision += 1;
    this.lastSavedRevision = this.project.revision;
    this.emit("change", this.project);
    return this.project;
  }

  /** Replace the entire project (used for "new project"). */
  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.canvasAdopted = false;
    this.currentPath = undefined;
    this.project = defaultProject();
    this.lastSavedRevision = this.project.revision;
    this.emit("change", this.project);
  }
}

/**
 * Bring a loaded project up to the current schema. v1 projects (single video
 * track, clip timing in SECONDS, sequential clips, no track index) are migrated
 * to v2 (multi-track, frame-based, absolute positions) — laying the old
 * sequential clips out end-to-end with transition overlaps preserved.
 */
function migrateProject(loaded: Project): Project {
  if (loaded.schemaVersion === PROJECT_SCHEMA_VERSION) return loaded;

  const fps = loaded.fps || 30;
  const s2f = (sec: number | undefined): number | undefined =>
    sec === undefined ? undefined : Math.round(sec * fps);

  type V1Clip = {
    id: string;
    assetId: string;
    sourceIn?: number;
    sourceOut?: number;
    startFrame?: number;
    sourceInFrame?: number;
    sourceOutFrame?: number;
    effects?: { speed?: number; fadeIn?: number; fadeOut?: number; [k: string]: unknown };
    transition?: { type: TransitionType; duration?: number; durationFrames?: number };
    overlays?: { start?: number; end?: number; [k: string]: unknown }[];
    captions?: { cues: { start?: number; end?: number; text: string }[]; [k: string]: unknown };
    graphics?: { start?: number; end?: number; [k: string]: unknown }[];
    audioOffset?: number;
  };

  loaded.tracks.forEach((track, ti) => {
    const t = track as Track;
    if (t.index === undefined) t.index = ti;
    if (!t.name) t.name = `${t.kind === "video" ? "V" : "A"}${ti + 1}`;

    let cursor = 0;
    let prevDurFrames = 0;
    t.clips = (track.clips as unknown as V1Clip[]).map((c, ci) => {
      // Already-migrated clip: pass through.
      if (c.sourceInFrame !== undefined && c.startFrame !== undefined) {
        return c as unknown as Clip;
      }
      const sourceInFrame = s2f(c.sourceIn) ?? 0;
      const sourceOutFrame = Math.max(sourceInFrame + 1, s2f(c.sourceOut) ?? sourceInFrame + 1);
      const speed = c.effects?.speed ?? 1;
      const durFrames = Math.max(1, Math.round((sourceOutFrame - sourceInFrame) / speed));
      const overlap = ci > 0 && c.transition?.duration ? Math.min(s2f(c.transition.duration)!, prevDurFrames, durFrames) : 0;
      const startFrame = ci === 0 ? 0 : cursor - overlap;
      cursor = startFrame + durFrames;
      prevDurFrames = durFrames;

      const effects = c.effects ? { ...c.effects } : undefined;
      if (effects) {
        if ("fadeIn" in effects) {
          (effects as Record<string, unknown>).fadeInFrames = s2f(effects.fadeIn);
          delete (effects as Record<string, unknown>).fadeIn;
        }
        if ("fadeOut" in effects) {
          (effects as Record<string, unknown>).fadeOutFrames = s2f(effects.fadeOut);
          delete (effects as Record<string, unknown>).fadeOut;
        }
      }

      const clip: Clip = {
        id: c.id,
        assetId: c.assetId,
        startFrame,
        sourceInFrame,
        sourceOutFrame,
        effects: effects as ClipEffects | undefined,
        transition: c.transition
          ? { type: c.transition.type, durationFrames: Math.max(1, s2f(c.transition.duration) ?? 1) }
          : undefined,
        overlays: c.overlays?.map((o) => {
          const { start, end, ...rest } = o;
          return { ...rest, startFrame: s2f(start), endFrame: s2f(end) } as unknown as TextOverlay;
        }),
        captions: c.captions
          ? {
              ...c.captions,
              cues: c.captions.cues.map((q) => ({ startFrame: s2f(q.start) ?? 0, endFrame: s2f(q.end) ?? 0, text: q.text })),
            } as unknown as Captions
          : undefined,
        graphics: c.graphics?.map((g) => {
          const { start, end, ...rest } = g;
          return { ...rest, startFrame: s2f(start), endFrame: s2f(end) } as unknown as GraphicOverlay;
        }),
        audioOffsetFrames: s2f(c.audioOffset),
      };
      return clip;
    });
  });

  if (loaded.music) {
    const m = loaded.music as unknown as { fadeIn?: number; fadeOut?: number; fadeInFrames?: number; fadeOutFrames?: number };
    if (m.fadeIn !== undefined) {
      m.fadeInFrames = s2f(m.fadeIn);
      delete m.fadeIn;
    }
    if (m.fadeOut !== undefined) {
      m.fadeOutFrames = s2f(m.fadeOut);
      delete m.fadeOut;
    }
  }

  loaded.schemaVersion = PROJECT_SCHEMA_VERSION;
  return loaded;
}
