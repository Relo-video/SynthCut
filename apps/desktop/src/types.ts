// Renderer-side mirror of the core project model (kept minimal & decoupled so
// the renderer bundle never pulls in Node-only core code).
import type { Keyframes, Transform } from "./keyframes";

export type { EaseKind, Keyframe, KeyframeProperty, Keyframes, Transform } from "./keyframes";

export interface MediaFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AssetTranscript {
  segments: TranscriptSegment[];
  model?: string;
  language?: string;
}

export interface MediaAsset {
  id: string;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** True for a still image (png/jpg/…): looped to fill its clip; drawn from an <img>. */
  isImage?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  addedAt: number;
  proxyPath?: string;
  /** Browser-playable preview proxy (alpha .webm) for motion-graphic overlays. */
  previewPath?: string;
  folderId?: string;
  transcript?: AssetTranscript;
  /** Present once visually indexed (shape mirrors core; not needed in detail by the UI). */
  visualSig?: { samples: unknown[]; bins: number };
}

export interface ColorAdjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGBWheel {
  r?: number;
  g?: number;
  b?: number;
}

export interface ColorGrade {
  temperature?: number;
  tint?: number;
  hue?: number;
  lift?: RGBWheel;
  gamma?: RGBWheel;
  gain?: RGBWheel;
  curve?: string;
  curveR?: string;
  curveG?: string;
  curveB?: string;
}

export interface VisualEffect {
  id: string;
  type: string;
  amount?: number;
  color?: string;
  params?: Record<string, number>;
}

/** A spoken-word search hit from search_transcript. */
export interface TranscriptHit {
  assetId: string;
  assetName: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

/** A visual-search result from search_visual. */
export interface VisualHit {
  assetId: string;
  name: string;
  score: number;
  atSeconds: number;
}

/** Result of inspect_color — numeric scopes + rendered scope image paths. */
export interface ColorInspection {
  stats: {
    luma: { min: number; avg: number; max: number; contrast: number };
    saturation: { avg: number; max: number };
    hue: { avg: number };
    rgb: { r: number; g: number; b: number };
    notes: string[];
  };
  scopes: { histogram: string; waveform: string; vectorscope: string };
}

export interface ClipEffects {
  speed?: number;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  color?: ColorAdjust;
  grade?: ColorGrade;
  lut?: string;
  filters?: VisualEffect[];
  crop?: CropRect;
  transform?: Transform;
  opacity?: number;
}

export type TransitionType =
  | "fade" | "dissolve" | "wipeleft" | "wiperight" | "wipeup" | "wipedown"
  | "slideleft" | "slideright" | "circleopen" | "circleclose"
  | "fadeblack" | "fadewhite" | "radial" | "smoothleft" | "smoothright";

export interface Transition {
  type: TransitionType;
  /** Overlap duration in frames. */
  durationFrames: number;
}

export type OverlayPosition =
  | "top" | "center" | "bottom" | "topleft" | "topright" | "bottomleft" | "bottomright";

/** Free-form text style shared by overlays and captions (mirrors the core). */
export interface TextStyle {
  position?: string;
  x?: number;
  y?: number;
  font?: string;
  fontSize?: number;
  color?: string;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  box?: boolean;
  boxColor?: string;
  boxBorderW?: number;
}

export type TextAnimProperty = "x" | "y" | "opacity";

export interface TextOverlay extends TextStyle {
  id: string;
  text: string;
  startFrame?: number;
  endFrame?: number;
  keyframes?: Partial<Record<TextAnimProperty, import("./keyframes").Keyframe[]>>;
}

export interface CaptionCue {
  startFrame: number;
  endFrame: number;
  text: string;
}

export interface Captions {
  cues: CaptionCue[];
  style?: TextStyle;
  model?: string;
  language?: string;
}

export interface GraphicOverlay {
  id: string;
  assetId: string;
  startFrame?: number;
  endFrame?: number;
  opacity?: number;
  code?: string;
  props?: Record<string, unknown>;
}

export interface Clip {
  id: string;
  assetId: string;
  startFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  effects?: ClipEffects;
  transition?: Transition;
  overlays?: TextOverlay[];
  captions?: Captions;
  graphics?: GraphicOverlay[];
  keyframes?: Keyframes;
  audioOffsetFrames?: number;
  linkGroupId?: string;
}

export interface MusicSettings {
  assetId: string;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  duck?: boolean;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  index: number;
  name?: string;
  muted?: boolean;
  volume?: number;
  hidden?: boolean;
  locked?: boolean;
  height?: number;
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  assets: MediaAsset[];
  folders?: MediaFolder[];
  tracks: Track[];
  music?: MusicSettings;
  /** Timeline-wide marker positions in frames (persisted; snap targets). */
  markers?: number[];
  revision: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** One frame = 1/fps seconds. Helpers for the renderer's seconds<->frames work. */
export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}
export function clipDurationFrames(clip: Clip): number {
  const speed = clip.effects?.speed ?? 1;
  return Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) / speed));
}

export interface ProgressInfo {
  job: "preview" | "export";
  fraction: number;
}

declare global {
  interface Window {
    aive?: {
      platform: string;
      pickFiles: () => Promise<string[]>;
      pickSavePath: () => Promise<string | null>;
      openProject: () => Promise<string | null>;
      saveProjectAs: (defaultName: string) => Promise<string | null>;
      onMenu: (cb: (action: string) => void) => void;
      reportProjectState: (state: { dirty: boolean; hasPath: boolean }) => void;
      getMcpConfig: () => Promise<{ available: boolean; packaged: boolean; mcpEntry: string | null; json: string }>;
    };
  }
}
