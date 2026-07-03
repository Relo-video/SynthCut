// Renderer-side mirror of packages/core/src/keyframes.ts — the SAME transform +
// keyframe math the engine and the FFmpeg bake use, so the live preview matches
// the export. Kept decoupled (no core import) like the rest of the desktop model
// mirror. See the core file for the transform-model documentation.

export type EaseKind = "linear" | "hold" | "ease" | "easeIn" | "easeOut";

export interface Keyframe {
  frame: number;
  value: number;
  ease?: EaseKind;
}

export type KeyframeProperty = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

export const KEYFRAME_PROPERTIES: KeyframeProperty[] = ["x", "y", "scale", "rotation", "opacity", "volume"];

export type Keyframes = Partial<Record<KeyframeProperty, Keyframe[]>>;

export interface Transform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

export const PROPERTY_DEFAULT: Record<KeyframeProperty, number> = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1,
};

export function easeProgress(u: number, ease: EaseKind | undefined): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  switch (ease) {
    case "hold": return 0;
    case "easeIn": return t * t;
    case "easeOut": return 1 - (1 - t) * (1 - t);
    case "ease": return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default: return t;
  }
}

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

export function effectiveValue(
  prop: KeyframeProperty,
  kfs: Keyframe[] | undefined,
  staticVal: number | undefined,
  f: number,
): number {
  if (kfs && kfs.length) return sampleTrack(kfs, f);
  return staticVal ?? PROPERTY_DEFAULT[prop];
}

/** The resolved transform of a clip at a clip-local frame (keyframes ∘ static). */
export interface EffectiveTransform {
  x: number;       // canvas fraction
  y: number;       // canvas fraction
  scale: number;
  rotation: number; // degrees
  flipH: boolean;
  flipV: boolean;
  opacity: number;  // 0..1 (does NOT include fades — caller multiplies those in)
}

/** Compute a clip's effective transform at clip-local frame `f`. */
export function effectiveTransform(
  transform: Transform | undefined,
  keyframes: Keyframes | undefined,
  opacity: number | undefined,
  f: number,
): EffectiveTransform {
  const t = transform ?? {};
  const k = keyframes;
  return {
    x: effectiveValue("x", k?.x, t.x, f),
    y: effectiveValue("y", k?.y, t.y, f),
    scale: effectiveValue("scale", k?.scale, t.scale, f),
    rotation: effectiveValue("rotation", k?.rotation, t.rotation, f),
    flipH: !!t.flipH,
    flipV: !!t.flipV,
    opacity: effectiveValue("opacity", k?.opacity, opacity, f),
  };
}

/** Identity transform check — lets the compositor skip the matrix when unused. */
export function isIdentityTransform(t: EffectiveTransform): boolean {
  return t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation === 0 && !t.flipH && !t.flipV && t.opacity === 1;
}
