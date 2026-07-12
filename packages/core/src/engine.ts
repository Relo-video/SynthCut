import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile, stat, readdir, rm, rename, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute, resolve, sep } from "node:path";
import { newId } from "./ids.js";
import { JobManager, type Job } from "./jobs.js";
import { pruneDataDir } from "./gc.js";
import { probeAsset } from "./ffmpeg/ffprobe.js";
import {
  detectSilence,
  detectScenes,
  inspectFrameColor,
  type SilenceRange,
  type SceneCut,
  type ColorInspection,
} from "./ffmpeg/analysis.js";
import { runFfmpeg, pickHwEncoder } from "./ffmpeg/executor.js";
import { planSegments, segmentKey, collectMtimes, type PlannedSegment } from "./ffmpeg/segments.js";
import { transcribe, transcribeFull, type TranscriptCue } from "./whisper/transcribe.js";
import { parseSrt, parseVtt, formatSrt, formatVtt } from "./captions/srt.js";
import { wrapText, maxCharsPerLine } from "./text/wrap.js";
import { projectToOtio, otioToProject } from "./interop/otio.js";
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
  type TranscriptWord,
  type Clip,
  type ClipEffects,
  type ColorGrade,
  type ExportSettings,
  type GraphicOverlay,
  type Marker,
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
  /** Emitted on every job state/progress change (start, progress, done/error/canceled). */
  job: (job: Job) => void;
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
  /** Last full preview render. Keyed by project id AND revision — revision is a
   *  per-project counter, so without the id a new/loaded project whose revision
   *  happens to match would wrongly serve the previous project's preview. */
  private previewCache: { projectId: string; revision: number; path: string } | null = null;
  /** Job id of the in-flight preview render, so a new preview cancels the old. */
  private previewJobId: string | null = null;
  /** Long-running work: observable, cancelable, progress-reporting (see jobs.ts). */
  readonly jobs = new JobManager();
  /** Debounced crash-recovery autosave timer (see scheduleRecoverySave). */
  private recoveryTimer: NodeJS.Timeout | null = null;
  /** Path of a crash-recovery file found at startup (cleared on explicit save). */
  private recoveryPath: string | null = null;
  /**
   * Heavy, immutable-per-asset derived data (transcripts, visual fingerprints)
   * kept OUTSIDE the project so `mutate()`'s undo snapshots stay small — a long
   * transcript cloned into 100 history entries was real memory pressure. Merged
   * back into the asset objects when the project is serialized (save/recovery)
   * and extracted again on load. Live assets carry a `transcriptIndexed` marker.
   */
  private assetCaches = new Map<string, { transcript?: AssetTranscript; visualSig?: VisualSignature }>();

  /** Directory where previews, thumbnails and other render artifacts are written. */
  constructor(readonly dataDir: string) {
    super();
    this.jobs.on("job", (job) => this.emit("job", job));
    // Crash recovery: 30s after the first unsaved change, snapshot the project
    // to <dataDir>/autosave/current.aive.recovery (cheap — it's JSON). An
    // explicit save clears it. If a previous session left one behind, surface
    // it so the UI/AI can offer recovery (load_project on it).
    const recovery = join(this.dataDir, "autosave", "current.aive.recovery");
    if (existsSync(recovery)) this.recoveryPath = recovery;
    this.on("change", () => this.scheduleRecoverySave());
  }

  // ---- crash recovery --------------------------------------------------------
  /**
   * Recovery snapshot info for the state envelope / get_state: whether a
   * crash-recovery file exists and where. Load it with load_project to recover.
   */
  recoveryInfo(): { available: boolean; path?: string } {
    return this.recoveryPath ? { available: true, path: this.recoveryPath } : { available: false };
  }

  private scheduleRecoverySave(): void {
    if (this.recoveryTimer) return; // already pending — throttle, don't re-arm
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.writeRecoverySnapshot().catch(() => {});
    }, 30_000);
    // Never keep the process alive just for an autosave.
    this.recoveryTimer.unref?.();
  }

  /**
   * The project as persisted to disk: the live project plus the engine-side
   * asset caches (transcripts, visual fingerprints) merged back onto their
   * assets, so a saved .aive file is self-contained.
   */
  private serializableProject(): Project {
    return {
      ...this.project,
      assets: this.project.assets.map((a) => {
        const cache = this.assetCaches.get(a.id);
        if (!cache?.transcript && !cache?.visualSig) return a;
        return { ...a, ...(cache.transcript ? { transcript: cache.transcript } : {}), ...(cache.visualSig ? { visualSig: cache.visualSig } : {}) };
      }),
    };
  }

  private async writeRecoverySnapshot(): Promise<void> {
    if (!this.isDirty() || !this.hasContent()) return;
    const dir = join(this.dataDir, "autosave");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "current.aive.recovery");
    // Plain project JSON so load_project can open it directly; the original
    // .aive path (if any) rides in a sidecar meta file.
    await writeFile(path, JSON.stringify(this.serializableProject(), null, 2), "utf8");
    await writeFile(
      join(dir, "current.aive.recovery.meta.json"),
      JSON.stringify({ originalPath: this.currentPath ?? null, savedAt: Date.now() }, null, 2),
      "utf8",
    );
    this.recoveryPath = path;
  }

  private async clearRecoverySnapshot(): Promise<void> {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const dir = join(this.dataDir, "autosave");
    await rm(join(dir, "current.aive.recovery"), { force: true }).catch(() => {});
    await rm(join(dir, "current.aive.recovery.meta.json"), { force: true }).catch(() => {});
    this.recoveryPath = null;
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

  /** The asset behind a clip, or undefined for an ADJUSTMENT layer (no source). */
  clipAsset(clip: Clip): MediaAsset | undefined {
    return clip.assetId ? this.project.assets.find((a) => a.id === clip.assetId) : undefined;
  }

  /** The clip's source asset, or a teaching error when it's an adjustment layer. */
  private requireClipAsset(clip: Clip, what: string): MediaAsset {
    if (clip.adjustment || !clip.assetId) {
      throw new Error(
        `Clip "${clip.id}" is an ADJUSTMENT layer — it has no source media, so ${what} doesn't apply. Target a footage clip instead (adjustment layers take color/effect tools only).`,
      );
    }
    return this.getAsset(clip.assetId);
  }

  /**
   * Security allowlist for the HTTP /file endpoint. A path is servable only if
   * it lives under the engine's data dir (previews/proxies/frames/baked/
   * thumbnails/scopes/…) or is the source/proxy/preview file of an imported
   * asset. Everything else — including `..` traversal attempts, which
   * path.resolve collapses before comparison — is rejected, so the server can
   * never be used to read arbitrary files on disk.
   */
  isServablePath(p: string): boolean {
    const norm = (s: string): string => {
      const r = resolve(s);
      // Windows paths are case-insensitive; compare them case-folded.
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    const target = norm(p);
    const dataRoot = norm(this.dataDir);
    if (target === dataRoot || target.startsWith(dataRoot + sep)) return true;
    for (const a of this.project.assets) {
      for (const candidate of [a.path, a.proxyPath, a.previewPath]) {
        if (candidate && norm(candidate) === target) return true;
      }
    }
    return false;
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
    // original. Fire-and-forget, but failures are RECORDED on the asset
    // (proxyError) so the state shows why scrubbing stayed slow.
    if (asset.hasVideo && Math.max(asset.width, asset.height) > PROXY_TRIGGER_LONG_EDGE) {
      void this.generateProxy(asset.id).catch((err) => {
        this.mutate(() => {
          const a = this.project.assets.find((x) => x.id === asset.id);
          if (a) a.proxyError = err instanceof Error ? err.message : String(err);
        });
      });
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
    const { promise } = this.jobs.start("proxy", `Proxy ${asset.name}`, async (signal, onProgress) => {
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
        await runFfmpeg(args, { signal, totalDuration: asset.duration, onProgress });
      }
      return this.mutate(() => {
        const a = this.getAsset(assetId);
        a.proxyPath = out;
        delete a.proxyError;
        return a;
      });
    });
    return promise;
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
    // The cache entry is deliberately KEPT: it lives outside the undo history,
    // so an undo of this removal restores the asset with its transcript/visual
    // index intact. Entries are dropped wholesale on reset()/load().
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
   * Place an ADJUSTMENT layer: a source-less clip whose color grade + effects
   * apply to the composite of every video track BELOW it while it's active.
   * Defaults to the TOPMOST video track (so it grades everything).
   */
  addAdjustmentClip(opts: { trackIndex?: number; startFrame: number; durationFrames: number }): Clip {
    return this.mutate(() => {
      const videoTracks = this.videoTracks();
      const track =
        opts.trackIndex === undefined
          ? videoTracks[videoTracks.length - 1]
          : this.trackByIndex(opts.trackIndex);
      if (!track || track.kind !== "video") {
        throw new Error(
          `Adjustment layers live on VIDEO tracks (they grade the picture below). Track ${opts.trackIndex} is ${track ? track.kind : "missing"} — pass a video trackIndex or omit it for the top video track.`,
        );
      }
      const durationFrames = Math.max(MIN_CLIP_FRAMES, Math.round(opts.durationFrames));
      const clip: Clip = {
        id: newId("clip"),
        adjustment: true,
        startFrame: Math.max(0, Math.round(opts.startFrame)),
        sourceInFrame: 0,
        sourceOutFrame: durationFrames,
      };
      track.clips.push(clip);
      EditorEngine.sortTrack(track);
      return clip;
    });
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
      // An adjustment layer has no source bounds — its "trim" just resizes the window.
      const assetFrames = clip.adjustment
        ? Number.MAX_SAFE_INTEGER
        : Math.max(MIN_CLIP_FRAMES, Math.round(this.requireClipAsset(clip, "trimming source frames").duration * this.project.fps));
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
    this.mutate(() => this.moveClipNoMutate(clipId, startFrame, trackIndex));
  }

  /** Move several clips at once (each to an absolute track+frame) as ONE undo step. */
  moveClips(moves: { clipId: string; startFrame: number; trackIndex?: number }[]): void {
    this.mutate(() => {
      for (const m of moves) this.moveClipNoMutate(m.clipId, m.startFrame, m.trackIndex);
    });
  }

  /** The body of moveClip without the undo/mutate wrapper (shared by moveClip/moveClips). */
  private moveClipNoMutate(clipId: string, startFrame: number, trackIndex?: number): void {
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

    const { promise } = this.jobs.start("transcribe", `Transcribe ${asset.name}`, async (signal) => {
      const dir = join(this.dataDir, "transcripts");
      await mkdir(dir, { recursive: true });
      const wav = join(dir, `${assetId}.wav`);
      await runFfmpeg(["-hide_banner", "-i", asset.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav], { signal });

      const model = opts.model ?? DEFAULT_MODEL;
      let result: Awaited<ReturnType<typeof transcribeFull>>;
      try {
        result = await transcribeFull(wav, { model, language: opts.language });
      } finally {
        // The 16kHz WAV is only whisper's input — delete it as soon as
        // transcription settles instead of letting it pile up on disk.
        await rm(wav, { force: true }).catch(() => {});
      }
      if (signal.aborted) throw new Error("Transcription canceled");
      const transcript: AssetTranscript = {
        segments: result.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
        words: result.words,
        model,
        language: opts.language ?? "en",
      };
      // Heavy data → engine cache (outside undo); the project only gets a marker.
      this.setCachedTranscript(assetId, transcript);
      const updated = this.mutate(() => {
        this.getAsset(assetId).transcriptIndexed = true;
        return this.getAsset(assetId);
      });
      return { asset: updated, segmentCount: transcript.segments.length, wordCount: transcript.words?.length ?? 0 };
    });
    return promise;
  }

  // ---- asset-cache accessors (transcript / visual index live outside undo) ---
  private setCachedTranscript(assetId: string, transcript: AssetTranscript): void {
    const entry = this.assetCaches.get(assetId) ?? {};
    entry.transcript = transcript;
    this.assetCaches.set(assetId, entry);
  }

  private setCachedVisualSig(assetId: string, sig: VisualSignature): void {
    const entry = this.assetCaches.get(assetId) ?? {};
    entry.visualSig = sig;
    this.assetCaches.set(assetId, entry);
  }

  private cachedTranscript(assetId: string): AssetTranscript | undefined {
    return this.assetCaches.get(assetId)?.transcript;
  }

  private cachedVisualSig(assetId: string): VisualSignature | undefined {
    return this.assetCaches.get(assetId)?.visualSig;
  }

  /** Assets with their cached transcript re-attached (for the pure ranking fn). */
  private assetsWithTranscripts(): MediaAsset[] {
    return this.project.assets.map((a) => {
      const t = this.cachedTranscript(a.id);
      return t ? { ...a, transcript: t } : a;
    });
  }

  /** Rank spoken-word hits across all INDEXED asset transcripts for a query. */
  searchTranscript(query: string, limit = 20): TranscriptHit[] {
    return rankTranscript(this.assetsWithTranscripts(), query, limit);
  }

  /** The cached transcript of an asset (segments in seconds), or null if not indexed. */
  getTranscript(assetId: string): AssetTranscript | null {
    this.getAsset(assetId); // teaches on a bad id
    return this.cachedTranscript(assetId) ?? null;
  }

  // ---- text-based editing (the words ARE the edit surface) -------------------

  /** Words of an asset's transcript, or a teaching error if not indexed with words. */
  private requireWords(assetId: string): TranscriptWord[] {
    this.getAsset(assetId);
    const words = this.cachedTranscript(assetId)?.words;
    if (!words?.length) {
      throw new Error(
        `Asset "${assetId}" has no word-level transcript. Run index_transcript on it first (word timestamps are built automatically), then read the numbered words with get_transcript.`,
      );
    }
    return words;
  }

  /** Merge overlapping/adjacent [start,end) second ranges (sorted output). */
  private static mergeSecondRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
    const sorted = ranges
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    const out: { start: number; end: number }[] = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else out.push({ ...r });
    }
    return out;
  }

  /**
   * Map SOURCE-second ranges of one asset onto absolute timeline frame ranges
   * across the given placed clips (speed-aware; clamped to each clip's source
   * window; ±padFrames of breathing room; merged per track). The same math as
   * locateInTimeline, pointed at cutting instead of seeking.
   */
  private sourceRangesToTimelineRanges(
    clips: { clip: Clip; trackIndex: number }[],
    ranges: { start: number; end: number }[],
    padFrames = 0,
  ): { trackIndex: number; startFrame: number; endFrame: number }[] {
    const fps = this.project.fps;
    const raw: { trackIndex: number; startFrame: number; endFrame: number }[] = [];
    for (const { clip, trackIndex } of clips) {
      const speed = clip.effects?.speed ?? 1;
      const inSec = clip.sourceInFrame / fps;
      const outSec = clip.sourceOutFrame / fps;
      const clipStart = clip.startFrame;
      const clipEnd = clipEndFrame(clip);
      for (const r of ranges) {
        const s = Math.max(r.start, inSec);
        const e = Math.min(r.end, outSec);
        if (e <= s) continue;
        let startFrame = clip.startFrame + Math.round(((s - inSec) / speed) * fps) - padFrames;
        let endFrame = clip.startFrame + Math.round(((e - inSec) / speed) * fps) + padFrames;
        startFrame = Math.max(clipStart, startFrame);
        endFrame = Math.min(clipEnd, endFrame);
        if (endFrame > startFrame) raw.push({ trackIndex, startFrame, endFrame });
      }
    }
    // Merge overlaps per track so one ripple pass sees clean ranges.
    const byTrack = new Map<number, { startFrame: number; endFrame: number }[]>();
    for (const r of raw) {
      (byTrack.get(r.trackIndex) ?? byTrack.set(r.trackIndex, []).get(r.trackIndex)!).push(r);
    }
    const merged: { trackIndex: number; startFrame: number; endFrame: number }[] = [];
    for (const [trackIndex, list] of byTrack) {
      list.sort((a, b) => a.startFrame - b.startFrame);
      for (const r of list) {
        const last = merged.filter((m) => m.trackIndex === trackIndex).pop();
        if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame);
        else merged.push({ trackIndex, ...r });
      }
    }
    return merged;
  }

  /**
   * TEXT-BASED EDITING: delete word ranges from every placed clip of an asset.
   * Word indices come from get_transcript's numbered words. Ranges are mapped
   * to absolute timeline frames (speed-aware), merged, then removed in ONE
   * ripple pass (a single undo step). Returns what was cut.
   */
  deleteTranscriptRanges(
    assetId: string,
    wordRanges: { fromWord: number; toWord: number }[],
    padFrames = 0,
  ): {
    cuts: number;
    framesRemoved: number;
    removedText: string[];
    ranges: { trackIndex: number; startFrame: number; endFrame: number }[];
  } {
    const words = this.requireWords(assetId);
    const secondRanges: { start: number; end: number }[] = [];
    const removedText: string[] = [];
    for (const r of wordRanges) {
      const from = Math.min(r.fromWord, r.toWord);
      const to = Math.max(r.fromWord, r.toWord);
      if (from < 0 || to >= words.length) {
        throw new Error(
          `Word range [${r.fromWord}, ${r.toWord}] is out of bounds — this transcript has words 0..${words.length - 1}. Read them with get_transcript.`,
        );
      }
      secondRanges.push({ start: words[from].start, end: words[to].end });
      removedText.push(words.slice(from, to + 1).map((w) => w.text).join(" "));
    }
    const merged = EditorEngine.mergeSecondRanges(secondRanges);

    const placed: { clip: Clip; trackIndex: number }[] = [];
    for (const track of this.project.tracks) {
      for (const clip of track.clips) if (clip.assetId === assetId) placed.push({ clip, trackIndex: track.index });
    }
    if (placed.length === 0) {
      throw new Error(
        `Asset "${assetId}" has no clips on the timeline — there is nothing to cut. Place it first (add_clip), or use this after building the timeline.`,
      );
    }

    const timelineRanges = this.sourceRangesToTimelineRanges(placed, merged, padFrames);
    if (timelineRanges.length === 0) {
      return { cuts: 0, framesRemoved: 0, removedText, ranges: [] };
    }
    this.rippleDeleteRanges(timelineRanges);
    const framesRemoved = timelineRanges.reduce((n, r) => n + (r.endFrame - r.startFrame), 0);
    return { cuts: timelineRanges.length, framesRemoved, removedText, ranges: timelineRanges };
  }

  /** Default filler vocabulary for tightenTalk (normalized, lowercase). */
  private static readonly DEFAULT_FILLERS = ["um", "uh", "uhm", "erm", "er", "hmm", "mhm", "mm"];

  /**
   * ONE-CALL talking-head cleanup: remove filler words and shrink long pauses
   * in a clip, via word-level transcript timings, as a single ripple pass /
   * undo step. Auto-transcribes the asset if needed. Linked clips (detached
   * audio) are cut at the same timeline ranges so they stay in sync.
   */
  async tightenTalk(
    clipId: string,
    opts: { removeFillers?: boolean; fillerWords?: string[]; maxPauseSec?: number; padFrames?: number } = {},
  ): Promise<{
    removed: { type: "filler" | "pause"; text?: string; start: number; end: number }[];
    cuts: number;
    framesRemoved: number;
    oldDurationFrames: number;
    newDurationFrames: number;
  }> {
    const { clip, track } = this.findClip(clipId);
    const asset = this.requireClipAsset(clip, "tighten_talk");
    if (!asset.hasAudio) {
      throw new Error("This clip's source has no audio — tighten_talk needs speech. Pick a talking clip.");
    }

    if (!this.cachedTranscript(asset.id)?.words?.length) {
      await this.indexTranscript(asset.id);
    }
    const words = this.requireWords(asset.id);

    const fps = this.project.fps;
    const inSec = clip.sourceInFrame / fps;
    const outSec = clip.sourceOutFrame / fps;
    const inWindow = words.filter((w) => w.end > inSec && w.start < outSec);
    if (inWindow.length === 0) {
      throw new Error(
        "No transcribed words fall inside this clip's source range — nothing to tighten. Check the clip covers the spoken part (get_transcript shows word times).",
      );
    }

    const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    const fillers = new Set((opts.fillerWords ?? EditorEngine.DEFAULT_FILLERS).map(normalize));
    const maxPauseSec = opts.maxPauseSec ?? 1.0;
    const padFrames = opts.padFrames ?? 1;
    const removeFillers = opts.removeFillers ?? true;

    const removed: { type: "filler" | "pause"; text?: string; start: number; end: number }[] = [];

    if (removeFillers) {
      for (let i = 0; i < inWindow.length; i++) {
        const w = inWindow[i];
        const norm = normalize(w.text);
        const prevGap = i === 0 ? Infinity : w.start - inWindow[i - 1].end;
        const nextGap = i === inWindow.length - 1 ? Infinity : inWindow[i + 1].start - w.end;
        if (fillers.has(norm)) {
          removed.push({ type: "filler", text: w.text, start: w.start, end: w.end });
        } else if (norm === "like" && prevGap >= 0.25 && nextGap >= 0.25) {
          // "like" is only a filler when isolated by pauses on both sides.
          removed.push({ type: "filler", text: w.text, start: w.start, end: w.end });
        } else if (norm === "you" && i + 1 < inWindow.length && normalize(inWindow[i + 1].text) === "know") {
          removed.push({ type: "filler", text: `${w.text} ${inWindow[i + 1].text}`, start: w.start, end: inWindow[i + 1].end });
          i++; // consume "know"
        }
      }
    }

    // Long pauses between consecutive words → shrink, leaving half of
    // maxPauseSec of natural air (centered).
    for (let i = 1; i < inWindow.length; i++) {
      const gap = inWindow[i].start - inWindow[i - 1].end;
      if (gap > maxPauseSec) {
        const air = maxPauseSec / 2;
        removed.push({
          type: "pause",
          start: inWindow[i - 1].end + air / 2,
          end: inWindow[i].start - air / 2,
        });
      }
    }

    if (removed.length === 0) {
      return { removed: [], cuts: 0, framesRemoved: 0, oldDurationFrames: clipDurationFrames(clip), newDurationFrames: clipDurationFrames(clip) };
    }

    const merged = EditorEngine.mergeSecondRanges(removed.map((r) => ({ start: r.start, end: r.end })));
    // Cut this clip AND its linked members (same absolute ranges → stays in sync).
    const primaryRanges = this.sourceRangesToTimelineRanges([{ clip, trackIndex: track.index }], merged, padFrames);
    const allRanges = [...primaryRanges];
    for (const member of this.linkedClips(clip)) {
      if (member.id === clip.id) continue;
      const memberTrack = this.findClip(member.id).track;
      for (const r of primaryRanges) {
        allRanges.push({ trackIndex: memberTrack.index, startFrame: r.startFrame, endFrame: r.endFrame });
      }
    }

    const oldDurationFrames = clipDurationFrames(clip);
    if (allRanges.length) this.rippleDeleteRanges(allRanges);
    const framesRemoved = primaryRanges.reduce((n, r) => n + (r.endFrame - r.startFrame), 0);

    return {
      removed: removed
        .sort((a, b) => a.start - b.start)
        .map((r) => ({ ...r, start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)) })),
      cuts: primaryRanges.length,
      framesRemoved,
      oldDurationFrames,
      newDurationFrames: oldDurationFrames - framesRemoved,
    };
  }

  /**
   * "Here's my script — assemble the cut": diff `keep` (the user's edited text)
   * against the asset's word-level transcript (LCS on normalized words), then
   * append one clip per kept span to the base video track, in order.
   */
  editByTranscript(
    assetId: string,
    keep: string,
    padSec = 0.08,
  ): {
    clipsCreated: string[];
    spans: { fromWord: number; toWord: number; text: string }[];
    matchedWords: number;
    keepWords: number;
    startFrame: number;
  } {
    const words = this.requireWords(assetId);
    const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    const a = words.map((w) => normalize(w.text));
    const b = (keep.match(/[\p{L}\p{N}']+/gu) ?? []).map(normalize).filter(Boolean);
    if (b.length === 0) {
      throw new Error("`keep` contains no words. Pass the edited text you want to keep, in the order it should play.");
    }
    if (a.length * b.length > 4_000_000) {
      throw new Error(
        `Transcript (${a.length} words) × keep text (${b.length} words) is too large to diff in one call. Split the work: use get_transcript to pick word indices and delete_transcript_ranges instead.`,
      );
    }

    // Classic LCS DP + backtrack → indices of transcript words that survive.
    const n = a.length;
    const m = b.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const keptIdx: number[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        keptIdx.push(i);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    if (keptIdx.length === 0) {
      throw new Error(
        "None of the keep text's words matched the transcript. Make sure `keep` quotes the transcript's actual wording (read it with get_transcript).",
      );
    }

    // Group consecutive transcript indices into spans.
    const spans: { fromWord: number; toWord: number }[] = [];
    for (const idx of keptIdx) {
      const last = spans[spans.length - 1];
      if (last && idx === last.toWord + 1) last.toWord = idx;
      else spans.push({ fromWord: idx, toWord: idx });
    }

    const fps = this.project.fps;
    const startFrame = this.trackEndFrame(this.baseVideoTrack());
    const created = this.mutate(() => {
      const track = this.baseVideoTrack();
      let cursor = this.trackEndFrame(track);
      const ids: string[] = [];
      for (const span of spans) {
        const sIn = Math.max(0, words[span.fromWord].start - padSec);
        const sOut = words[span.toWord].end + padSec;
        const clip = this.makeClip(
          assetId,
          cursor,
          Math.round(sIn * fps),
          Math.round(sOut * fps),
        );
        track.clips.push(clip);
        cursor = clipEndFrame(clip);
        ids.push(clip.id);
      }
      EditorEngine.sortTrack(track);
      return ids;
    });

    return {
      clipsCreated: created,
      spans: spans.map((s) => ({
        ...s,
        text: words.slice(s.fromWord, s.toWord + 1).map((w) => w.text).join(" "),
      })),
      matchedWords: keptIdx.length,
      keepWords: m,
      startFrame,
    };
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
        const transcript = asset ? this.cachedTranscript(asset.id) : undefined;
        const segs = transcript?.segments;
        if (!asset || !segs?.length) continue;
        const hits = rankTranscript([{ ...asset, transcript }], query, 1000);
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
    const preAsset = this.getAsset(assetId);
    if (!preAsset.hasVideo) throw new Error("Asset has no video to fingerprint");
    const { promise } = this.jobs.start("index_visual", `Visual index ${preAsset.name}`, () =>
      this.indexVisualRun(assetId, count),
    );
    return promise;
  }

  private async indexVisualRun(
    assetId: string,
    count: number,
  ): Promise<{ asset: MediaAsset; sampleCount: number; semantic: boolean }> {
    const asset = this.getAsset(assetId);
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
    // Heavy fingerprint → engine cache (outside undo history), no project mutation.
    this.setCachedVisualSig(assetId, sig);
    return { asset: this.getAsset(assetId), sampleCount: sig.samples.length, semantic };
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
        let sig = this.cachedVisualSig(asset.id);
        if (!sig || !sig.samples.some((s) => s.embed)) {
          await this.indexVisual(asset.id);
          sig = this.cachedVisualSig(asset.id)!;
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
      refAssetId = this.requireClipAsset(clip, "visual search by reference frame").id;
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
      let sig = this.cachedVisualSig(asset.id);
      if (!sig) {
        await this.indexVisual(asset.id);
        sig = this.cachedVisualSig(asset.id)!;
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
    const clipAsset = this.requireClipAsset(clip, "audio sync");
    const refAsset = this.requireClipAsset(ref, "audio sync");

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

  /**
   * Replace the timeline markers. Accepts bare frame numbers (back-compat) or
   * full Marker objects ({frame, name?, color?, note?}). Deduped by frame
   * (later entries win), sorted, non-negative integer frames.
   */
  setMarkers(markers: (number | Marker)[]): void {
    this.mutate(() => {
      const byFrame = new Map<number, Marker>();
      for (const m of markers) {
        const marker: Marker = typeof m === "number" ? { frame: m } : { ...m };
        marker.frame = Math.max(0, Math.round(marker.frame));
        byFrame.set(marker.frame, marker);
      }
      const clean = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
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
    if (this.project.markers) {
      this.project.markers = this.project.markers.map((m) => ({ ...m, frame: sc(m.frame) }));
    }
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
      const f2s = (f: number) => framesToSeconds(f, fps);

      // ADJUSTMENT layer: no source input — resolve just its window + effects
      // (color/grade/LUT/filters, applied to the stacked composite in graph.ts).
      if (clip.adjustment) {
        let adjEffects: ResolvedEffects | undefined;
        const e = clip.effects;
        if (e) {
          adjEffects = { color: e.color, grade: e.grade, lut: e.lut, filters: e.filters };
          if (adjEffects.lut) {
            let name = lutMap.get(adjEffects.lut);
            if (!name) {
              name = `lut${lutIdx++}.cube`;
              await copyFile(adjEffects.lut, join(work, name));
              lutMap.set(adjEffects.lut, name);
            }
            adjEffects = { ...adjEffects, lut: name };
          }
        }
        resolved.push({
          path: "",
          adjustment: true,
          trackIndex: track.index,
          showVideo: track.kind === "video" && !track.hidden,
          startSec: f2s(clip.startFrame),
          sourceIn: 0,
          sourceSpan: f2s(clip.sourceOutFrame - clip.sourceInFrame),
          outDuration: framesToSeconds(clipDurationFrames(clip), fps),
          hasAudio: false,
          muted: true,
          effects: adjEffects,
        });
        continue;
      }

      const asset = this.getAsset(clip.assetId!);

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
          const dWrap = defaultTextStyle(this.project.height, ov.fontSize);
          // Auto-wrap to the canvas (drawtext has no wrapping); explicit
          // newlines in the author's text are respected as-is.
          await writeFile(join(work, textFile), wrapText(ov.text, maxCharsPerLine(this.project.width, dWrap.fontSize)), "utf8");
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
          const dWrap = defaultTextStyle(this.project.height, st.fontSize);
          // Same auto-wrap as overlays — imported SRT cues can be long lines.
          await writeFile(join(work, textFile), wrapText(cue.text, maxCharsPerLine(this.project.width, dWrap.fontSize)), "utf8");
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
        // An audio-only asset (wav/mp3) placed on a video track must never
        // enter the video graph — its input has no [N:v] stream to consume.
        showVideo: track.kind === "video" && !track.hidden && asset.hasVideo,
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
    const asset = this.requireClipAsset(clip, "caption transcription");
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
    let cues: TranscriptCue[];
    try {
      cues = await transcribe(wav, { model, language: opts.language, maxLen: opts.maxLen });
    } finally {
      // The extracted WAV is only whisper's input — clean it up immediately.
      await rm(wav, { force: true }).catch(() => {});
    }

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

  /**
   * Write every placed clip's captions as ONE sidecar file (SRT or VTT) with
   * ABSOLUTE timeline times: clip-local cue frames → clip.startFrame offset →
   * seconds (speed is already baked into stored cue frames). Merged and sorted.
   */
  async exportCaptions(path: string, format?: "srt" | "vtt"): Promise<{ path: string; cueCount: number; format: string }> {
    const fps = this.project.fps;
    const fmt = format ?? (path.toLowerCase().endsWith(".vtt") ? "vtt" : "srt");
    const cues: { start: number; end: number; text: string }[] = [];
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        for (const cue of clip.captions?.cues ?? []) {
          cues.push({
            start: framesToSeconds(clip.startFrame + cue.startFrame, fps),
            end: framesToSeconds(clip.startFrame + cue.endFrame, fps),
            text: cue.text,
          });
        }
      }
    }
    if (cues.length === 0) {
      throw new Error(
        "No captions on the timeline to export. Generate them first (generate_captions on a clip) or import a sidecar with import_captions.",
      );
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fmt === "vtt" ? formatVtt(cues) : formatSrt(cues), "utf8");
    return { path, cueCount: cues.length, format: fmt };
  }

  /**
   * Attach a sidecar caption file (SRT/VTT) to a clip as its caption track
   * (replaces existing captions). Cue times are ABSOLUTE timeline seconds and
   * are converted to clip-local frames; cues outside the clip are dropped.
   */
  async importCaptions(clipId: string, path: string): Promise<{ clip: Clip; cueCount: number; dropped: number }> {
    const { clip } = this.findClip(clipId);
    const raw = await readFile(path, "utf8");
    const isVtt = path.toLowerCase().endsWith(".vtt") || /^﻿?WEBVTT/.test(raw);
    const parsed = isVtt ? parseVtt(raw) : parseSrt(raw);
    if (parsed.length === 0) {
      throw new Error(
        `No cues found in "${basename(path)}". Expected SubRip (.srt) or WebVTT (.vtt) with hh:mm:ss,mmm --> hh:mm:ss,mmm timing lines.`,
      );
    }
    const fps = this.project.fps;
    const durFrames = clipDurationFrames(clip);
    const local = parsed
      .map((c) => ({
        startFrame: clamp(secondsToFrames(c.start, fps) - clip.startFrame, 0, durFrames),
        endFrame: clamp(secondsToFrames(c.end, fps) - clip.startFrame, 0, durFrames),
        text: c.text,
      }))
      .filter((c) => c.endFrame > c.startFrame);
    if (local.length === 0) {
      throw new Error(
        `All ${parsed.length} cues fall outside this clip's timeline window (frames ${clip.startFrame}..${clip.startFrame + durFrames}). Cue times are ABSOLUTE timeline seconds — pick the clip the captions belong to.`,
      );
    }
    const updated = this.mutate(() => {
      const { clip: target } = this.findClip(clipId);
      target.captions = { cues: local, style: target.captions?.style };
      return target;
    });
    return { clip: updated, cueCount: local.length, dropped: parsed.length - local.length };
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
  /**
   * Render-cache instrumentation (read by smoke-cache): how many segments were
   * re-encoded vs served from cache, and how often the single-pass path ran.
   */
  readonly renderStats = { segmentRenders: 0, segmentCacheHits: 0, singlePassRenders: 0 };

  /** Full timeline extent in seconds (video + slipped audio), same math as graph.ts. */
  private fullTimelineSeconds(staged: ResolvedRenderClip[]): number {
    let total = 0;
    for (const c of staged) {
      total = Math.max(total, c.startSec + c.outDuration);
      const aShift = c.audioOffset && c.audioOffset > 0 ? c.audioOffset : 0;
      if (c.hasAudio) total = Math.max(total, c.startSec + aShift + c.outDuration);
    }
    return Math.max(total, 1 / this.project.fps);
  }

  /**
   * Ensure one planned segment exists in the cache (render it if missing).
   * Returns its path. Cache entries are video-only MPEG-TS at the preview
   * canvas/profile; `hw` is the hardware encoder to try (falls back to sw).
   */
  private async ensureSegmentRendered(
    staged: ResolvedRenderClip[],
    cwd: string,
    canvas: Canvas,
    seg: PlannedSegment,
    mtimes: Record<string, number>,
    hw: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const dir = join(this.dataDir, "cache", "segments");
    await mkdir(dir, { recursive: true });
    const key = segmentKey(staged, seg, canvas, PREVIEW_PROFILE, mtimes, hw);
    const path = join(dir, `${key}.ts`);
    if (await fileExists(path)) {
      this.renderStats.segmentCacheHits += 1;
      // Touch for the GC's LRU ordering.
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return path;
    }
    const tmp = `${path}.tmp-${process.pid}`;
    const render = (enc: string | null) =>
      buildRenderCommand(staged, canvas, tmp, PREVIEW_PROFILE, undefined, undefined, {
        window: seg,
        videoOnly: true,
        mpegts: true,
        hwEncoder: enc,
      });
    try {
      await runFfmpeg(render(hw).args, { cwd, signal });
    } catch (err) {
      if (signal?.aborted || !hw) throw err;
      // A listed hardware encoder can still fail at runtime — retry software.
      await runFfmpeg(render(null).args, { cwd, signal });
    }
    await rename(tmp, path);
    this.renderStats.segmentRenders += 1;
    return path;
  }

  /** Segment-cached preview: render only missing segments, concat, one audio pass. */
  private async renderPreviewSegmented(
    outPath: string,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<RenderResult> {
    const canvas = previewCanvas(this.canvas);
    const { clips: staged, cwd } = await this.stageRender();
    const total = this.fullTimelineSeconds(staged);
    const segments = planSegments(staged, total);
    const mtimes = await collectMtimes(staged);
    const hw = await pickHwEncoder("h264");

    const segPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (signal.aborted) throw new Error("Preview render canceled");
      segPaths.push(await this.ensureSegmentRendered(staged, cwd, canvas, segments[i], mtimes, hw, signal));
      const f = ((i + 1) / segments.length) * 0.8;
      onProgress(f);
      this.emit("progress", { job: "preview", fraction: f });
    }

    // Concat list (bare ../-free absolute paths with forward slashes; keys are hex).
    const listPath = join(this.dataDir, "cache", "segments", `concat-${Date.now()}.txt`);
    await writeFile(listPath, segPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");

    // ONE cheap audio-only pass over the full timeline (mixing is fast).
    const audioPath = `${outPath}.audio.m4a`;
    const audio = buildRenderCommand(staged, canvas, audioPath, PREVIEW_PROFILE, this.resolveMusic(), undefined, {
      audioOnly: true,
    });
    await runFfmpeg(audio.args, { cwd, signal, totalDuration: audio.totalDuration, onProgress: (f) => {
      const g = 0.8 + f * 0.15;
      onProgress(g);
      this.emit("progress", { job: "preview", fraction: g });
    } });

    try {
      // Lossless assembly: copy the concatenated video + the audio pass.
      await runFfmpeg(
        [
          "-hide_banner",
          "-f", "concat", "-safe", "0", "-i", listPath,
          "-i", audioPath,
          "-map", "0:v:0", "-map", "1:a:0",
          "-c", "copy", "-movflags", "+faststart",
          "-y", outPath,
        ],
        { signal },
      );
    } finally {
      await rm(listPath, { force: true }).catch(() => {});
      await rm(audioPath, { force: true }).catch(() => {});
    }
    onProgress(1);
    this.emit("progress", { job: "preview", fraction: 1 });
    return { path: outPath, duration: total };
  }

  async renderPreview(): Promise<RenderResult> {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to preview");

    // A new preview supersedes any in-flight one (its job ends "canceled").
    if (this.previewJobId) this.jobs.cancel(this.previewJobId);

    const { job, promise } = this.jobs.start("preview", "Preview render", async (signal, onProgress) => {
      const dir = join(this.dataDir, "previews");
      await mkdir(dir, { recursive: true });
      const outPath = join(dir, `preview-${this.project.revision}-${Date.now()}.mp4`);

      // Segment-cached path first (near-instant for small edits); single-pass
      // fallback on any cache/concat error. AIVE_SEGMENT_CACHE=off disables.
      if (process.env.AIVE_SEGMENT_CACHE !== "off") {
        try {
          const result = await this.renderPreviewSegmented(outPath, signal, onProgress);
          this.previewCache = { projectId: this.project.id, revision: this.project.revision, path: outPath };
          void pruneDataDir(this.dataDir).catch(() => {});
          return result;
        } catch (err) {
          if (signal.aborted) throw err;
          console.error(
            `[aive] segment-cached preview failed (${err instanceof Error ? err.message : err}); falling back to single-pass`,
          );
        }
      }

      const canvas = previewCanvas(this.canvas);
      const { clips: staged, cwd } = await this.stageRender();
      const hw = await pickHwEncoder("h264");
      const build = (enc: string | null) =>
        buildRenderCommand(staged, canvas, outPath, PREVIEW_PROFILE, this.resolveMusic(), undefined, { hwEncoder: enc });

      const { args, totalDuration } = build(hw);
      const run = (a: string[]) =>
        runFfmpeg(a, {
          cwd,
          totalDuration,
          signal,
          onProgress: (fraction) => {
            onProgress(fraction);
            this.emit("progress", { job: "preview", fraction });
          },
        });
      try {
        await run(args);
      } catch (err) {
        if (signal.aborted || !hw) throw err;
        await run(build(null).args); // hardware encoder failed at runtime → software
      }
      this.renderStats.singlePassRenders += 1;

      this.previewCache = { projectId: this.project.id, revision: this.project.revision, path: outPath };
      void pruneDataDir(this.dataDir).catch(() => {});
      return { path: outPath, duration: totalDuration } satisfies RenderResult;
    });
    this.previewJobId = job.id;
    return promise;
  }

  /**
   * Render a single composited frame of the whole timeline at `atSeconds` and
   * return its PNG path. Fast paths, in order: extract from a fresh cached full
   * preview; render/reuse ONLY the cache segment containing `t` (near-instant
   * verify loop); fall back to a full preview render.
   */
  async renderFrame(atSeconds?: number): Promise<string> {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to show");

    const total = this.timelineDuration();
    const t = Math.min(Math.max(0, atSeconds ?? total / 2), Math.max(0, total - 0.05));
    const dir = join(this.dataDir, "frames");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `frame-${Date.now()}.png`);

    const extract = async (from: string, at: number, outputSeek = false) => {
      // MPEG-TS segments have no seek index — input-side -ss can land nowhere
      // and emit zero frames. Output-side seek decodes from the start instead
      // (segments are ≤10s, so this stays cheap); mp4 previews keep the fast
      // input-side seek.
      const seek = ["-ss", Math.max(0, at).toFixed(3)];
      const args = outputSeek
        ? ["-hide_banner", "-i", from, ...seek, "-frames:v", "1", "-y", outPath]
        : ["-hide_banner", ...seek, "-i", from, "-frames:v", "1", "-y", outPath];
      await runFfmpeg(args);
      return outPath;
    };

    const preview = this.previewCache;
    const fresh =
      preview &&
      preview.projectId === this.project.id &&
      preview.revision === this.project.revision &&
      (await fileExists(preview.path));
    if (fresh) return extract(preview!.path, t);

    // No fresh preview: render just the ONE segment containing t (or reuse its
    // cached file) instead of the whole timeline.
    if (process.env.AIVE_SEGMENT_CACHE !== "off") {
      try {
        const canvas = previewCanvas(this.canvas);
        const { clips: staged, cwd } = await this.stageRender();
        const fullTotal = this.fullTimelineSeconds(staged);
        const segments = planSegments(staged, fullTotal);
        const seg = segments.find((s) => t >= s.start && t < s.end) ?? segments[segments.length - 1];
        if (seg) {
          const mtimes = await collectMtimes(staged);
          const hw = await pickHwEncoder("h264");
          const segPath = await this.ensureSegmentRendered(staged, cwd, canvas, seg, mtimes, hw);
          return await extract(segPath, t - seg.start, true);
        }
      } catch (err) {
        console.error(
          `[aive] single-segment frame render failed (${err instanceof Error ? err.message : err}); falling back to full preview`,
        );
      }
    }

    const r = await this.renderPreview();
    return extract(r.path, t);
  }

  /** Render the final export to `outputPath` with optional encoding settings (blocking). */
  async exportVideo(outputPath: string, settings?: ExportSettings): Promise<RenderResult> {
    return this.startExportJob(outputPath, settings).promise;
  }

  /**
   * Start an export as a cancelable JOB. Blocking callers await `.promise`;
   * background callers keep `.job.id` and poll list_jobs / cancel_job. A
   * canceled or failed export deletes its partial output file.
   */
  startExportJob(outputPath: string, settings?: ExportSettings): { job: Job; promise: Promise<RenderResult> } {
    if (this.clipCount() === 0) throw new Error("Timeline is empty — nothing to export");

    return this.jobs.start("export", `Export → ${basename(outputPath)}`, async (signal, onProgress) => {
      await mkdir(dirname(outputPath), { recursive: true });
      const { clips: staged, cwd } = await this.stageRender();
      // Export defaults to SOFTWARE encoding for quality; `hardware: true` opts
      // into NVENC/QSV/AMF/VideoToolbox for speed (with sw retry on failure).
      const hw = settings?.hardware
        ? await pickHwEncoder(settings.videoCodec === "h265" ? "h265" : "h264")
        : null;
      const build = (enc: string | null) =>
        buildRenderCommand(staged, this.canvas, outputPath, EXPORT_PROFILE, this.resolveMusic(), settings, { hwEncoder: enc });
      const { args, totalDuration } = build(hw);

      const run = (a: string[]) =>
        runFfmpeg(a, {
          cwd,
          totalDuration,
          signal,
          onProgress: (fraction) => {
            onProgress(fraction);
            this.emit("progress", { job: "export", fraction });
          },
        });
      // Don't leave a half-written (or, on a graceful SIGTERM, a fully
      // finalized-but-unwanted) file behind on cancel/failure. Retry the
      // delete a few times: on Windows the OS can hold the file handle
      // briefly after the killed process exits.
      const deletePartial = async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await rm(outputPath, { force: true });
            return;
          } catch {
            await new Promise((res) => setTimeout(res, 100));
          }
        }
      };
      try {
        try {
          await run(args);
        } catch (err) {
          if (signal.aborted || !hw) throw err;
          await run(build(null).args); // hardware encoder failed at runtime → software
        }
      } catch (err) {
        await deletePartial();
        throw err;
      }
      // ffmpeg reacts to a cancelSignal's SIGTERM by finishing up gracefully
      // (a complete, valid, but truncated file) rather than always rejecting
      // — so `run()` above can resolve normally even though we canceled.
      if (signal.aborted) {
        await deletePartial();
        throw new Error("Export canceled");
      }

      void pruneDataDir(this.dataDir).catch(() => {});
      return { path: outputPath, duration: totalDuration } satisfies RenderResult;
    });
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
    const asset = this.requireClipAsset(clip, "stabilization");
    const { promise } = this.jobs.start("stabilize", `Stabilize ${asset.name}`, (signal, onProgress) =>
      this.stabilizeClipRun(clipId, signal, onProgress),
    );
    return promise;
  }

  private async stabilizeClipRun(
    clipId: string,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<Clip> {
    const { clip } = this.findClip(clipId);
    const asset = this.requireClipAsset(clip, "stabilization");
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
      // Pass 1 (analysis) ≈ first half of the work.
      { cwd: dir, signal, totalDuration: spanSec, onProgress: (f) => onProgress(f * 0.5) },
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
    await runFfmpeg(pass2, { cwd: dir, signal, totalDuration: spanSec, onProgress: (f) => onProgress(0.5 + f * 0.5) });

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
    const { clip: pre } = this.findClip(clipId);
    const preAsset = this.requireClipAsset(pre, "auto-reframe");
    if (!preAsset.hasVideo || preAsset.width <= 0 || preAsset.height <= 0) {
      throw new Error("Auto-reframe needs a clip with a decodable video stream");
    }
    const { promise } = this.jobs.start("reframe", `Auto-reframe ${preAsset.name}`, (signal, onProgress) =>
      this.autoReframeRun(clipId, opts, signal, onProgress),
    );
    return promise;
  }

  private async autoReframeRun(
    clipId: string,
    opts: { sampleFps?: number; smoothing?: number; scoreThreshold?: number },
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<{ clip: Clip; hitRate: number; cropWidth: number; cropHeight: number; keyframes: number }> {
    const { clip } = this.findClip(clipId);
    const asset = this.requireClipAsset(clip, "auto-reframe");

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
    if (signal.aborted) throw new Error("Auto-reframe canceled");
    onProgress(0.5); // tracking done; the bake reports the second half
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
    await runFfmpeg(bake, { cwd: dir, signal, totalDuration: spanSec, onProgress: (f) => onProgress(0.5 + f * 0.5) });

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
    const { promise } = this.jobs.start("graphic", "Render motion graphic", (signal) =>
      this.addGraphicRun(clipId, opts, signal),
    );
    return promise;
  }

  private async addGraphicRun(
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
    signal: AbortSignal,
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

    if (signal.aborted) throw new Error("Motion-graphic render canceled");
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
    const asset = this.requireClipAsset(clip, "inspect_clip");
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
    await writeFile(path, JSON.stringify(this.serializableProject(), null, 2), "utf8");
    this.currentPath = path;
    this.lastSavedRevision = this.project.revision;
    // The work is safely on disk — the crash-recovery snapshot is now stale.
    await this.clearRecoverySnapshot();
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
    // Pull persisted transcripts/visual fingerprints OUT of the live project
    // into the engine cache (kept outside the undo history); leave markers.
    this.assetCaches.clear();
    for (const a of this.project.assets) {
      if (a.transcript || a.visualSig) {
        this.assetCaches.set(a.id, {
          ...(a.transcript ? { transcript: a.transcript } : {}),
          ...(a.visualSig ? { visualSig: a.visualSig } : {}),
        });
        a.transcriptIndexed = !!a.transcript;
        delete a.transcript;
        delete a.visualSig;
      }
    }
    this.canvasAdopted = true;
    this.currentPath = path;
    this.project.revision += 1;
    this.lastSavedRevision = this.project.revision;
    this.emit("change", this.project);
    return this.project;
  }

  /**
   * Write the project as an OpenTimelineIO (.otio) JSON file — the interchange
   * handoff to Resolve/Premiere/Hiero/etc. SynthCut-specific data rides in
   * metadata.synthcut so re-importing here is lossless.
   */
  async exportOtio(path: string): Promise<{ path: string; trackCount: number; clipCount: number }> {
    const timeline = projectToOtio(this.serializableProject());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(timeline, null, 2), "utf8");
    return { path, trackCount: this.project.tracks.length, clipCount: this.clipCount() };
  }

  /**
   * Load an OpenTimelineIO (.otio) JSON file as the CURRENT project. Referenced
   * media is probed from disk; files that can't be found become offline
   * placeholder assets (missing: true) so the structure survives and media can
   * be relinked. Returns any structural warnings + the missing paths.
   */
  async importOtio(path: string): Promise<{ project: Project; warnings: string[]; missing: string[] }> {
    const raw = await readFile(path, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`"${basename(path)}" is not valid JSON. OTIO files are plain JSON — check the export from the other tool.`);
    }
    const result = await otioToProject(json, async (mediaPath) => {
      try {
        return await probeAsset(mediaPath);
      } catch {
        return null;
      }
    });

    this.undoStack = [];
    this.redoStack = [];
    this.project = migrateProject(result.project);
    // Extract any transcripts/visual indexes that traveled in asset metadata.
    this.assetCaches.clear();
    for (const a of this.project.assets) {
      if (a.transcript || a.visualSig) {
        this.assetCaches.set(a.id, {
          ...(a.transcript ? { transcript: a.transcript } : {}),
          ...(a.visualSig ? { visualSig: a.visualSig } : {}),
        });
        a.transcriptIndexed = !!a.transcript;
        delete a.transcript;
        delete a.visualSig;
      }
    }
    this.canvasAdopted = true;
    this.currentPath = undefined; // an .otio import has no .aive home yet
    this.project.revision += 1;
    this.lastSavedRevision = this.project.revision;
    this.emit("change", this.project);
    return { project: this.project, warnings: result.warnings, missing: result.missing };
  }

  /** Replace the entire project (used for "new project"). */
  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.canvasAdopted = false;
    this.currentPath = undefined;
    this.assetCaches.clear();
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

  // v2 (or v1) → v3: bare marker frame numbers become Marker objects. Additive
  // and order-preserving; runs for every pre-v3 project.
  if (Array.isArray(loaded.markers)) {
    loaded.markers = (loaded.markers as unknown as (number | Marker)[]).map((m) =>
      typeof m === "number" ? { frame: m } : m,
    );
  }

  if ((loaded.schemaVersion ?? 1) >= 2) {
    // Already multi-track/frame-based — only the marker upgrade was needed.
    loaded.schemaVersion = PROJECT_SCHEMA_VERSION;
    return loaded;
  }

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
