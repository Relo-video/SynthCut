/**
 * Core data model for the AI-Native Video Editor.
 *
 * Editing is fully **non-destructive**: source files are never modified. A
 * project is an Edit Decision List (EDL) — clips that *reference* regions of
 * imported media assets, laid out on a multi-track, frame-based timeline.
 * Preview and export both compile this EDL into a single FFmpeg filtergraph.
 *
 * ## Timing unit: FRAMES
 * The project's `fps` is the canonical timing unit. **Every** position and
 * duration in the model is an integer count of project frames — clip placement
 * (`startFrame`), source trims (`sourceInFrame`/`sourceOutFrame`), fades, text
 * and caption windows, transition lengths, audio slip, and music fades. Seconds
 * only appear at the FFmpeg boundary, where the engine converts frames→seconds
 * with the helpers below. One frame = `1 / fps` seconds.
 */

import type { EaseKind, Keyframe, KeyframeProperty, Keyframes, Transform } from "./keyframes.js";

export type { EaseKind, Keyframe, KeyframeProperty, Keyframes, Transform } from "./keyframes.js";

/** Convert a frame count to seconds at the given fps. */
export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/** Convert seconds to the nearest whole frame at the given fps. */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/** Probed metadata about a source media file. Immutable once imported. */
export interface MediaAsset {
  id: string;
  /** Absolute path to the source file on the user's machine. */
  path: string;
  /** Display name (basename by default). */
  name: string;
  /** Total source duration in seconds (as probed). */
  duration: number;
  width: number;
  height: number;
  /** Frames per second (best-effort, from avg/r_frame_rate). */
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** True for a still image (png/jpg/…): looped to fill its clip's duration. */
  isImage?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  /** Epoch ms when the asset was added to the project. */
  addedAt: number;
  /**
   * Optional low-res PROXY for snappy preview/scrub of large/4K sources. Preview
   * uses it when present; EXPORT always uses the full-res original (`path`).
   */
  proxyPath?: string;
  /**
   * Why the background proxy transcode failed (if it did) — recorded instead of
   * being swallowed, so clients can explain slow scrubbing and retry via
   * generate_proxy. Cleared when a proxy succeeds.
   */
  proxyError?: string;
  /**
   * Optional BROWSER-PLAYABLE preview proxy (VP8/alpha .webm) for assets whose
   * `path` a browser can't decode — currently alpha motion-graphic ProRes .mov
   * overlays. The Canvas2D preview draws this so graphics show live; EXPORT still
   * uses the full-quality `path`.
   */
  previewPath?: string;
  /** Optional library folder this asset belongs to (id of a {@link MediaFolder}). */
  folderId?: string;
  /**
   * Cached spoken-word transcript (for search). NOTE: at runtime this lives in
   * the engine's assetCaches (outside the undo history — transcripts are large
   * and immutable per asset); it is merged back into this field only when the
   * project is SERIALIZED (.aive save / crash-recovery snapshot) and extracted
   * again on load. Live project state carries `transcriptIndexed` instead.
   */
  transcript?: AssetTranscript;
  /** True when a transcript is cached for this asset (the live-state marker). */
  transcriptIndexed?: boolean;
  /**
   * True when the source file could not be found on disk (offline placeholder
   * from an OTIO/project import). Rendering clips of a missing asset fails —
   * re-import or relink the file, or remove_asset it.
   */
  missing?: boolean;
  /** Cached perceptual visual fingerprint. Same engine-cache lifecycle as `transcript`. */
  visualSig?: VisualSignature;
}

/** A library folder for organizing imported assets (flat; assets carry folderId). */
export interface MediaFolder {
  id: string;
  name: string;
  /** Epoch ms created (for stable ordering). */
  createdAt: number;
}

/** A timed spoken-word segment of an asset's audio (seconds, asset-relative). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** A single spoken WORD with per-word timing (seconds, asset-relative). */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

/** A full asset transcript (spoken-word index for search), plus which model made it. */
export interface AssetTranscript {
  segments: TranscriptSegment[];
  /**
   * Word-level timestamps (whisper token offsets merged into words). The basis
   * of text-based editing: delete_transcript_ranges / tighten_talk /
   * edit_by_transcript address these by index.
   */
  words?: TranscriptWord[];
  model?: string;
  language?: string;
}

/**
 * One sampled keyframe's perceptual fingerprint: a 64-bit difference hash (as a
 * 16-char hex string) for structure + a small normalized RGB histogram for
 * color. Used for fully-local "find shots that look like this" search.
 */
export interface VisualSample {
  /** Sample time in seconds (asset-relative). */
  t: number;
  /** 8×8 difference hash, 64 bits as 16 hex chars. */
  dhash: string;
  /** Normalized color histogram (concatenated R,G,B bins), sums to ~1. */
  hist: number[];
  /** Optional CLIP image embedding (unit-normalized) when a semantic model indexed it. */
  embed?: number[];
}

/** An asset's perceptual visual index (a handful of sampled keyframes). */
export interface VisualSignature {
  samples: VisualSample[];
  /** Histogram bin count per channel (so hist length = 3 × bins). */
  bins: number;
}

/** Color grading adjustments, applied via FFmpeg's `eq` filter. */
export interface ColorAdjust {
  /** Additive brightness, -1..1 (0 = unchanged). */
  brightness?: number;
  /** Contrast multiplier, 0..3 (1 = unchanged). */
  contrast?: number;
  /** Saturation multiplier, 0..3 (1 = unchanged). */
  saturation?: number;
  /** Gamma, 0.1..10 (1 = unchanged). */
  gamma?: number;
}

/** Source-pixel crop rectangle (for manual reframing). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A per-channel offset for one tonal range of a color wheel (each -1..1; 0 = neutral). */
export interface RGBWheel {
  r?: number;
  g?: number;
  b?: number;
}

/**
 * A richer, secondary color grade applied AFTER the basic {@link ColorAdjust}
 * (eq) and BEFORE any creative LUT. All fields optional; absent = neutral.
 * Baked into the FFmpeg filtergraph (colorbalance / hue / curves) and previewed
 * with a CSS-filter proxy (within reason — FFmpeg export is ground truth).
 */
export interface ColorGrade {
  /** White balance warm↔cool, -1..1 (0 = neutral; + = warmer/redder, − = cooler/bluer). */
  temperature?: number;
  /** White balance green↔magenta, -1..1 (0 = neutral; + = magenta, − = green). */
  tint?: number;
  /** Global hue rotation in degrees, -180..180. */
  hue?: number;
  /** Lift wheel — shifts SHADOWS toward a color (colorbalance shadows). */
  lift?: RGBWheel;
  /** Gamma wheel — shifts MIDTONES toward a color (colorbalance midtones). */
  gamma?: RGBWheel;
  /** Gain wheel — shifts HIGHLIGHTS toward a color (colorbalance highlights). */
  gain?: RGBWheel;
  /** Master/luma tone curve as space-separated x/y points 0..1, e.g. "0/0 0.5/0.6 1/1". */
  curve?: string;
  /** Per-channel tone curves (same "x/y x/y" form) on red/green/blue. */
  curveR?: string;
  curveG?: string;
  curveB?: string;
}

/** A creative/utility visual effect baked as an FFmpeg filter (blur/sharpen/etc.). */
export interface VisualEffect {
  /** Stable id so the UI/AI can remove or update a single effect. */
  id: string;
  /**
   * Effect kind (a documented vocabulary mapped to FFmpeg filters in graph.ts):
   * blur | sharpen | detail | denoise | sepia | grayscale | vignette |
   * posterize | edges | pixelate | chromakey.
   */
  type: string;
  /** Primary strength, meaning depends on `type` (e.g. blur sigma, sharpen amount). */
  amount?: number;
  /** Color argument for effects that need one (e.g. chromakey key color). */
  color?: string;
  /** Extra numeric params for effects that take more than one (e.g. chromakey similarity/blend). */
  params?: Record<string, number>;
}

export type OverlayPosition =
  | "top"
  | "center"
  | "bottom"
  | "topleft"
  | "topright"
  | "bottomleft"
  | "bottomright";

/**
 * Free-form visual style for burned-in text (overlays AND captions). Every
 * field is optional with a sensible default — the AI composes whatever look it
 * wants rather than picking from a fixed menu.
 */
export interface TextStyle {
  /** Keyword position (top/center/bottom/topleft/topright/bottomleft/bottomright). */
  position?: string;
  /** Free placement as a fraction of the canvas (0..1), text centered on the point. Overrides `position`. */
  x?: number;
  y?: number;
  /** Font family name (resolved from installed fonts) OR an absolute path to a .ttf/.otf/.ttc. */
  font?: string;
  /** Font size in pixels (relative to the output canvas). Default 48. */
  fontSize?: number;
  /** Font color — FFmpeg color: a name, #RRGGBB, or name@alpha (e.g. "white@0.9"). Default "white". */
  color?: string;
  /** Outline / stroke around the glyphs. */
  outlineColor?: string;
  outlineWidth?: number;
  /** Drop shadow. */
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  /** Translucent background box behind the text. Default true. */
  box?: boolean;
  /** Box color with optional @alpha. Default "black@0.5". */
  boxColor?: string;
  /** Box padding in pixels. Default 12. */
  boxBorderW?: number;
}

/** Animatable text properties (canvas fractions for x/y; 0..1 for opacity). */
export type TextAnimProperty = "x" | "y" | "opacity";

/** A burned-in text overlay (title / lower-third / freeform text) on a clip. */
export interface TextOverlay extends TextStyle {
  id: string;
  text: string;
  /** Show from this frame (frames from the clip's start). Default 0. */
  startFrame?: number;
  /** Hide after this frame (frames from the clip's start). Default end of clip. */
  endFrame?: number;
  /**
   * Optional keyframe animation of the text's position/opacity over time —
   * native animated titles (fly-ins, slides, fades) WITHOUT code. Frames are
   * CLIP-LOCAL (0 = the clip's start), x/y are canvas fractions, opacity 0..1.
   */
  keyframes?: Partial<Record<TextAnimProperty, Keyframe[]>>;
}

/** A text overlay resolved for rendering (text written to a file, font staged). */
export interface ResolvedOverlay {
  textFile: string;
  fontFile: string;
  fontSize: number;
  color: string;
  box: boolean;
  boxColor: string;
  boxBorderW: number;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  position: string;
  x?: number;
  y?: number;
  /** Window in seconds from the clip's start (frames converted at resolve time). */
  start?: number;
  end?: number;
  /** Keyframe tracks resolved to clip-local seconds (x/y canvas fractions, opacity 0..1). */
  keyframes?: Partial<Record<TextAnimProperty, ResolvedKeyframe[]>>;
}

/** Visual style for a clip's caption track (same free-form vocabulary as overlays). */
export type CaptionStyle = TextStyle;

/** A single timed caption cue. Times are frames from the clip's start on the timeline. */
export interface CaptionCue {
  startFrame: number;
  endFrame: number;
  text: string;
}

/**
 * Auto-generated (Whisper) caption track for a clip. Kept separate from manual
 * text overlays so it can be regenerated or cleared independently; at render
 * time the cues are compiled into the same drawtext path as overlays.
 */
export interface Captions {
  cues: CaptionCue[];
  style?: CaptionStyle;
  /** Which whisper model produced these (for display / re-runs). */
  model?: string;
  /** Detected/used language code. */
  language?: string;
}

/**
 * A motion-graphic overlay on a clip: an AI-authored Remotion component rendered
 * (headless) to a standalone **alpha** video asset, then composited over the
 * clip's picture within a frame window at render time. The TSX `code` (and
 * `props`) are retained so the graphic can be re-rendered (e.g. at a new canvas
 * resolution).
 */
export interface GraphicOverlay {
  id: string;
  /** The baked alpha video asset (the rendered motion graphic). */
  assetId: string;
  /** Show from this frame (frames from the clip's start). Default 0. */
  startFrame?: number;
  /** Hide after this frame (frames from the clip's start). Default = start + graphic duration. */
  endFrame?: number;
  /** Overall opacity of the graphic, 0..1. Default 1. */
  opacity?: number;
  /** The Remotion component source (TSX) that produced this graphic. */
  code?: string;
  /** Props passed to the component when it was rendered. */
  props?: Record<string, unknown>;
}

/** A motion graphic resolved for rendering (asset path + placement window in seconds). */
export interface ResolvedGraphic {
  /** Absolute path to the baked alpha video. */
  path: string;
  start?: number;
  end?: number;
  opacity?: number;
}

/** Supported crossfade/transition styles (FFmpeg xfade transitions). */
export type TransitionType =
  | "fade"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "slideleft"
  | "slideright"
  | "circleopen"
  | "circleclose"
  | "fadeblack"
  | "fadewhite"
  | "radial"
  | "smoothleft"
  | "smoothright";

/**
 * A transition entering a clip from the previous clip on the SAME track. The
 * two clips overlap by `durationFrames` on the timeline and crossfade over that
 * overlap (overlap-based model).
 */
export interface Transition {
  type: TransitionType;
  /** Overlap duration in frames. */
  durationFrames: number;
}

/** Per-clip effects. All optional; absent fields mean "unchanged". */
export interface ClipEffects {
  /** Playback speed multiplier, 0.25..4 (1 = normal). Affects timeline duration. */
  speed?: number;
  /** Audio gain multiplier (1 = unchanged, 0 = mute). */
  volume?: number;
  /** Video fade-in / fade-out durations in frames. */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** Color grade (basic brightness/contrast/saturation/gamma → eq). */
  color?: ColorAdjust;
  /** Richer secondary grade (white balance, lift/gamma/gain wheels, hue, tone curves). */
  grade?: ColorGrade;
  /** Absolute path to a .cube LUT to apply. */
  lut?: string;
  /** Creative/utility visual effects (blur, sharpen, key, …), applied in order after color. */
  filters?: VisualEffect[];
  /** Crop applied to the source before scaling to the canvas. */
  crop?: CropRect;
  /** 2D transform (position/scale/rotation/flip) applied after fit-to-canvas. */
  transform?: Transform;
  /** Static opacity 0..1 (multiplies fades + any opacity keyframes). Default 1. */
  opacity?: number;
}

/**
 * A clip placed on a track at an absolute timeline position. References a region
 * [sourceInFrame, sourceOutFrame) of an asset (in project frames). Its timeline
 * footprint is `durationFrames = round((sourceOutFrame - sourceInFrame) / speed)`
 * — see {@link clipDurationFrames}. Clips on a track may have gaps or overlaps;
 * an overlap with the previous clip plus a `transition` produces a crossfade.
 */
export interface Clip {
  id: string;
  /** Source asset. ABSENT for adjustment layers (`adjustment: true`). */
  assetId?: string;
  /**
   * True = ADJUSTMENT LAYER: a source-less clip whose color grade + effects
   * apply to the composite of every video track BELOW it, only while the clip
   * is active on the timeline. Grade/effect tools (apply_color, apply_effect,
   * color_grade, …) work on it unchanged — they only touch `effects`.
   */
  adjustment?: boolean;
  /** Absolute start position on the track, in project frames. */
  startFrame: number;
  /** Start point within the source asset, in project frames (seconds × fps). */
  sourceInFrame: number;
  /** End point within the source asset, in project frames (> sourceInFrame). */
  sourceOutFrame: number;
  /** Optional per-clip effects. */
  effects?: ClipEffects;
  /** Optional transition entering this clip from the previous one on the same track. */
  transition?: Transition;
  /** Optional burned-in text overlays. */
  overlays?: TextOverlay[];
  /** Optional auto-generated caption track (from Whisper transcription). */
  captions?: Captions;
  /** Optional motion-graphic overlays (AI-authored Remotion components, baked to alpha). */
  graphics?: GraphicOverlay[];
  /** Optional keyframe animation tracks (position/scale/rotation/opacity/volume). */
  keyframes?: Keyframes;
  /**
   * Slide this clip's audio relative to its video, in frames, for J/L cuts.
   * Negative = audio leads the picture (J-cut). Positive = audio trails (L-cut).
   * 0/absent = locked to the video.
   */
  audioOffsetFrames?: number;
  /**
   * Clips sharing a `linkGroupId` (typically a video clip and its detached
   * audio on another track) move/trim/split/delete together by default until
   * unlinked.
   */
  linkGroupId?: string;
}

export type TrackKind = "video" | "audio";

/**
 * A track holds clips at absolute frame positions. `index` is a stable, unique
 * stacking key: among VIDEO tracks, higher `index` composites ON TOP of lower
 * (the base/background track has the lowest index). Audio tracks use `index`
 * only for stable ordering.
 */
export interface Track {
  id: string;
  kind: TrackKind;
  /** Unique stacking/identity key. Video z-order = ascending index (bottom→top). */
  index: number;
  /** Display name (e.g. "V1", "A1", "B-roll"). */
  name?: string;
  /** Audio is silenced when muted. */
  muted?: boolean;
  /** Track audio gain multiplier applied to every clip's audio (1 = unchanged). */
  volume?: number;
  /** Video is excluded from the composite when hidden. */
  hidden?: boolean;
  /** Editing on this track is disabled in the UI when locked. */
  locked?: boolean;
  /** UI display height in pixels. */
  height?: number;
  /** Clips on this track (kept sorted by startFrame). */
  clips: Clip[];
}

/** Background music mixed under the whole timeline. */
export interface MusicSettings {
  assetId: string;
  /** Music gain multiplier (e.g. 0.3 keeps it under speech). */
  volume: number;
  /** Fade durations in frames. */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** Duck (auto-lower) the music whenever the main audio is present. */
  duck?: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Output canvas width in pixels. */
  width: number;
  /** Output canvas height in pixels. */
  height: number;
  /** Output frame rate — the canonical timing unit for all frame counts. */
  fps: number;
  /** Imported media library. */
  assets: MediaAsset[];
  /** Optional library folders for organizing assets. */
  folders?: MediaFolder[];
  /** Tracks (video and audio). Stacking/identity is by Track.index, not array order. */
  tracks: Track[];
  /** Optional background music mixed under the whole timeline. */
  music?: MusicSettings;
  /**
   * Timeline-wide NAMED markers (ruler flags + snap targets + the human↔AI
   * annotation channel: leave notes for the editor/reviewer on the timeline).
   */
  markers?: Marker[];
  /** Bumped on every mutation; lets clients detect staleness. */
  revision: number;
  /** Schema version of this project (for .aive migration). */
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** A named timeline marker (frame-positioned ruler flag with optional annotation). */
export interface Marker {
  /** Absolute timeline frame. */
  frame: number;
  /** Short label shown in the ruler tooltip. */
  name?: string;
  /** Display color (CSS color for the UI flag). */
  color?: string;
  /** Longer annotation — review notes, to-dos, hand-off context. */
  note?: string;
}

/**
 * Current project schema version. v1 = single-track seconds; v2 = multi-track
 * frames; v3 = named markers ({frame,name?,color?,note?} instead of number[]).
 */
export const PROJECT_SCHEMA_VERSION = 3;

/** Timeline footprint of a clip in project frames (accounts for speed). */
export function clipDurationFrames(clip: Clip): number {
  const speed = clip.effects?.speed ?? 1;
  return Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) / speed));
}

/** Absolute end frame (exclusive) of a clip on its track. */
export function clipEndFrame(clip: Clip): number {
  return clip.startFrame + clipDurationFrames(clip);
}

/**
 * A single clip resolved for rendering (used by the filtergraph builder). All
 * timing is in SECONDS and absolute on the timeline — the engine converts from
 * the frame-based model at stage time so the graph builder stays frame-agnostic.
 */
export interface ResolvedRenderClip {
  /** Source file path ("" for adjustment layers — they contribute no input). */
  path: string;
  /** True = adjustment layer: apply `effects` to the stacked composite below. */
  adjustment?: boolean;
  /** Stacking key of the owning track (video z-order; ascending = on top). */
  trackIndex: number;
  /** Include this clip's picture in the composite (video track AND not hidden). */
  showVideo: boolean;
  /** Absolute start time on the timeline, in seconds. */
  startSec: number;
  /** Start point within the source, in seconds. */
  sourceIn: number;
  /** Amount of source to read, in seconds. */
  sourceSpan: number;
  /** True for a still image source — looped to fill the clip instead of seeked. */
  isImage?: boolean;
  /** Output (timeline) duration of the clip in seconds (after speed). */
  outDuration: number;
  hasAudio: boolean;
  /** True if the owning track is muted (audio dropped from the mix). */
  muted: boolean;
  /** Track-level audio gain (multiplies the clip's own volume). */
  trackVolume?: number;
  /** Effects, with fades resolved to seconds. */
  effects?: ResolvedEffects;
  /** Transition entering this clip from the previous clip in the same render run. */
  transition?: { type: TransitionType; duration: number };
  /** Resolved text overlays (text written to files, font staged). */
  overlays?: ResolvedOverlay[];
  /** Resolved motion-graphic overlays (alpha videos composited over the clip). */
  graphics?: ResolvedGraphic[];
  /** Audio slide vs. video in seconds (J/L cuts). */
  audioOffset?: number;
}

/** A keyframe with its time resolved to clip-local SECONDS (for FFmpeg `T` expressions). */
export interface ResolvedKeyframe {
  sec: number;
  value: number;
  ease?: EaseKind;
}

/** Effects with frame-based fields resolved to seconds for the graph builder. */
export interface ResolvedEffects {
  speed?: number;
  volume?: number;
  /** Fade durations in seconds. */
  fadeIn?: number;
  fadeOut?: number;
  color?: ColorAdjust;
  grade?: ColorGrade;
  lut?: string;
  filters?: VisualEffect[];
  crop?: CropRect;
  /** Static 2D transform (raw fractions/degrees; baked in graph.ts). */
  transform?: Transform;
  /** Static opacity 0..1. */
  opacity?: number;
  /** Keyframe tracks with times resolved to clip-local seconds. */
  keyframes?: Partial<Record<KeyframeProperty, ResolvedKeyframe[]>>;
}

/**
 * Export encoding settings (container/codec/quality/audio). All optional —
 * absent fields fall back to a high-quality H.264 MP4. Resolution and fps come
 * from the project canvas (set_project_settings); these control HOW it's encoded.
 */
export interface ExportSettings {
  /** Container: mp4 (default) | mov | webm (forces vp9/opus). */
  container?: "mp4" | "mov" | "webm";
  /** Video codec: h264 (default) | h265 | vp9. */
  videoCodec?: "h264" | "h265" | "vp9";
  /** Constant-quality CRF (lower = better/bigger). Codec-appropriate default if absent. */
  quality?: number;
  /** Fixed video bitrate (e.g. "8M") — overrides quality/CRF when set. */
  videoBitrate?: string;
  /** Encoder speed/quality preset (x264/x265: ultrafast…veryslow). Default "medium". */
  preset?: string;
  /** Audio codec: aac (default) | opus (webm). */
  audioCodec?: "aac" | "opus";
  /** Audio bitrate, e.g. "192k". */
  audioBitrate?: string;
  /**
   * Opt into HARDWARE video encoding (NVENC/QSV/AMF/VideoToolbox) for SPEED at
   * some quality-per-bit cost. Export defaults to software libx264/x265 for
   * quality; previews use hardware automatically when available (AIVE_HWENC).
   */
  hardware?: boolean;
  /**
   * Normalize the final mix to this integrated loudness (LUFS, e.g. -14 for
   * YouTube/social, -16 for web). Applied as a single-pass `loudnorm` on the
   * export's master audio. Omit for no normalization (master preset).
   */
  loudnessTarget?: number;
  /** True-peak ceiling in dBTP for loudness normalization (default -1.5). */
  truePeak?: number;
}

/** Output canvas geometry for a render. */
export interface Canvas {
  width: number;
  height: number;
  fps: number;
}
