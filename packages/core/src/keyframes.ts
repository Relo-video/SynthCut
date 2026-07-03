/**
 * Per-clip transform + keyframe animation — the pure math, shared by the engine,
 * the FFmpeg bake (graph.ts builds time-expressions from the same model) and,
 * mirrored, by the desktop preview compositor. No I/O, no FFmpeg, no DOM.
 *
 * ## Transform model (preview and export agree exactly)
 * A clip's picture is first fit (contain) to the output canvas, centered. The
 * transform then, about the canvas CENTER: mirror (flipH/flipV) → scale → rotate
 * (degrees, clockwise) → translate by (x·W, y·H) where x,y are fractions of the
 * canvas. `opacity` multiplies the clip's alpha (on top of fades). Identity =
 * { x:0, y:0, scale:1, rotation:0, flip*:false, opacity:1 }.
 */

/** Interpolation into a keyframe (describes the segment ENDING at that keyframe). */
export type EaseKind = "linear" | "hold" | "ease" | "easeIn" | "easeOut";

/** One keyframe: a value at a clip-local timeline frame (0 = clip start). */
export interface Keyframe {
  frame: number;
  value: number;
  ease?: EaseKind;
}

/** Animatable scalar properties. (Crop stays a static effect for now.) */
export type KeyframeProperty = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

export const KEYFRAME_PROPERTIES: KeyframeProperty[] = ["x", "y", "scale", "rotation", "opacity", "volume"];

/** A clip's keyframe tracks: property → keyframes sorted ascending by frame. */
export type Keyframes = Partial<Record<KeyframeProperty, Keyframe[]>>;

/** Static per-clip 2D transform. All fields optional; absent = identity. */
export interface Transform {
  /** Horizontal offset as a fraction of canvas width (+ = right). */
  x?: number;
  /** Vertical offset as a fraction of canvas height (+ = down). */
  y?: number;
  /** Uniform scale multiplier (1 = fit-to-canvas, <1 shrinks, >1 zooms). */
  scale?: number;
  /** Rotation in degrees, clockwise. */
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

/** Identity value of each animatable property (used when neither keyframes nor a static value exist). */
export const PROPERTY_DEFAULT: Record<KeyframeProperty, number> = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1,
};

/** Map a 0..1 segment progress through an easing curve. */
export function easeProgress(u: number, ease: EaseKind | undefined): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  switch (ease) {
    case "hold": return 0; // step: hold the left value until the next keyframe
    case "easeIn": return t * t;
    case "easeOut": return 1 - (1 - t) * (1 - t);
    case "ease": return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default: return t; // linear
  }
}

/**
 * Sample a sorted keyframe track at clip-local frame `f`. Clamps to the first /
 * last keyframe outside the range. Returns NaN for an empty track.
 */
export function sampleTrack(kfs: Keyframe[], f: number): number {
  if (!kfs.length) return NaN;
  if (f <= kfs[0].frame) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (f >= last.frame) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (f >= a.frame && f <= b.frame) {
      const span = b.frame - a.frame;
      const p = span <= 0 ? 1 : easeProgress((f - a.frame) / span, b.ease);
      return a.value + (b.value - a.value) * p;
    }
  }
  return last.value;
}

/**
 * Effective value of a property at clip-local frame `f`: its keyframe track if
 * present, otherwise the static value, otherwise the property default.
 */
export function effectiveValue(
  prop: KeyframeProperty,
  kfs: Keyframe[] | undefined,
  staticVal: number | undefined,
  f: number,
): number {
  if (kfs && kfs.length) return sampleTrack(kfs, f);
  return staticVal ?? PROPERTY_DEFAULT[prop];
}

/** Does this clip have any non-identity GEOMETRIC transform or transform/opacity animation? */
export function hasVisualTransform(
  transform: Transform | undefined,
  keyframes: Keyframes | undefined,
  opacity: number | undefined,
): boolean {
  const t = transform ?? {};
  if ((t.x ?? 0) !== 0 || (t.y ?? 0) !== 0) return true;
  if ((t.scale ?? 1) !== 1 || (t.rotation ?? 0) !== 0) return true;
  if (t.flipH || t.flipV) return true;
  if (opacity !== undefined && opacity !== 1) return true;
  for (const p of ["x", "y", "scale", "rotation", "opacity"] as KeyframeProperty[]) {
    if (keyframes?.[p]?.length) return true;
  }
  return false;
}

/** Sort a keyframe list ascending by frame (stable; in place). */
export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return kfs.sort((a, b) => a.frame - b.frame);
}
