import type {
  Canvas,
  ClipEffects,
  ColorGrade,
  ExportSettings,
  KeyframeProperty,
  ResolvedEffects,
  ResolvedGraphic,
  ResolvedKeyframe,
  ResolvedOverlay,
  ResolvedRenderClip,
  RGBWheel,
  VisualEffect,
} from "../types.js";

export interface RenderProfile {
  /** x264 preset (speed/quality tradeoff). */
  preset: string;
  /** Constant Rate Factor (lower = higher quality / bigger file). */
  crf: number;
  /** Audio bitrate, e.g. "192k". */
  audioBitrate: string;
}

export const EXPORT_PROFILE: RenderProfile = {
  preset: "medium",
  crf: 18,
  audioBitrate: "192k",
};

export const PREVIEW_PROFILE: RenderProfile = {
  preset: "veryfast",
  crf: 28,
  audioBitrate: "128k",
};

/** Round down to the nearest even integer (x264 requires even dimensions). */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * Named per-platform export presets. Resolution/fps come from the project
 * canvas; these set the container/codec/quality. The AI or UI can name one and
 * still override individual fields.
 */
export const EXPORT_PRESETS: Record<string, ExportSettings> = {
  youtube: { container: "mp4", videoCodec: "h264", quality: 18, audioBitrate: "192k" },
  youtube_hevc: { container: "mp4", videoCodec: "h265", quality: 22, audioBitrate: "192k" },
  social: { container: "mp4", videoCodec: "h264", quality: 20, audioBitrate: "128k" }, // Reels/Shorts/TikTok
  square: { container: "mp4", videoCodec: "h264", quality: 20, audioBitrate: "160k" },
  web: { container: "webm", videoCodec: "vp9", quality: 32, audioCodec: "opus", audioBitrate: "128k" },
  master: { container: "mov", videoCodec: "h264", quality: 14, preset: "slow", audioBitrate: "256k" },
};
export const EXPORT_PRESET_NAMES = Object.keys(EXPORT_PRESETS) as (keyof typeof EXPORT_PRESETS)[];

/**
 * For preview we render at a reduced canvas (long edge capped) for speed while
 * preserving the project aspect ratio. Export uses the full canvas.
 */
export function previewCanvas(canvas: Canvas, maxLongEdge = 1280): Canvas {
  const longEdge = Math.max(canvas.width, canvas.height);
  if (longEdge <= maxLongEdge) return canvas;
  const scale = maxLongEdge / longEdge;
  return {
    width: even(canvas.width * scale),
    height: even(canvas.height * scale),
    fps: canvas.fps,
  };
}

export interface RenderCommand {
  args: string[];
  /** Total output duration in seconds (for progress reporting). */
  totalDuration: number;
}

/** Background music resolved for rendering (fades already converted to seconds). */
export interface ResolvedMusic {
  path: string;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  duck?: boolean;
}

/**
 * Decompose a speed multiplier into a chain of `atempo` factors, since a single
 * atempo only accepts 0.5..2.0. e.g. speed 4 -> [2,2]; speed 0.25 -> [0.5,0.5].
 */
function atempoFactors(speed: number): number[] {
  const factors: number[] = [];
  let s = speed;
  while (s > 2.0 + 1e-9) {
    factors.push(2.0);
    s /= 2.0;
  }
  while (s < 0.5 - 1e-9) {
    factors.push(0.5);
    s /= 0.5;
  }
  factors.push(Number(s.toFixed(6)));
  return factors;
}

// ---- per-clip transform + keyframe animation (baked into the filtergraph) ----
//
// A clip's keyframe tracks (resolved to clip-local seconds) and/or static
// transform are compiled into FFmpeg time-expressions of `T`. The geometric
// transform is baked with a single `geq` that, for each output pixel, inverts
// the affine (translate→rotate→scale→flip about the canvas centre) and samples
// the fitted layer — the SAME math the desktop Canvas2D compositor uses, so
// preview and export agree. geq is only emitted when a clip actually has a
// non-identity transform / opacity / animation (normal clips keep the fast path).

const num = (n: number): string => (Number.isFinite(n) ? n.toFixed(6) : "0");

/** Easing curve as an expression over the normalized segment progress `u`. */
function easeExpr(u: string, ease: ResolvedKeyframe["ease"]): string {
  switch (ease) {
    case "hold": return "0";
    case "easeIn": return `(${u})*(${u})`;
    case "easeOut": return `(1-(1-(${u}))*(1-(${u})))`;
    case "ease": return `if(lt(${u},0.5),2*(${u})*(${u}),1-2*(1-(${u}))*(1-(${u})))`;
    default: return `(${u})`;
  }
}

/** Linear/eased value between two keyframes a→b at time `tvar`. */
function segExpr(a: ResolvedKeyframe, b: ResolvedKeyframe, tvar: string): string {
  const span = b.sec - a.sec;
  if (span <= 1e-9) return num(b.value);
  const u = `((${tvar}-${num(a.sec)})/${num(span)})`;
  return `(${num(a.value)}+(${num(b.value)}-(${num(a.value)}))*(${easeExpr(u, b.ease)}))`;
}

/**
 * Compile a keyframe track (or a static fallback) into an FFmpeg expression of
 * `tvar` (seconds). Clamps to the first/last keyframe outside the range. The
 * result is meant to live inside a single-quoted filter option, so embedded
 * commas (if/lt/…) need no escaping.
 */
function kfExpr(kfs: ResolvedKeyframe[] | undefined, staticVal: number, tvar: string): string {
  if (!kfs || !kfs.length) return num(staticVal);
  const n = kfs.length;
  let expr = num(kfs[n - 1].value); // held after the last keyframe
  for (let i = n - 2; i >= 0; i--) {
    expr = `if(lt(${tvar},${num(kfs[i + 1].sec)}),${segExpr(kfs[i], kfs[i + 1], tvar)},${expr})`;
  }
  return `if(lt(${tvar},${num(kfs[0].sec)}),${num(kfs[0].value)},${expr})`;
}

/** Any keyframe track that drives the geometric transform / opacity? */
function hasTransformKf(kf: ResolvedEffects["keyframes"]): boolean {
  if (!kf) return false;
  return (["x", "y", "scale", "rotation", "opacity"] as KeyframeProperty[]).some((p) => kf[p]?.length);
}

/** True when a clip needs the geq transform stage (non-identity transform / opacity / animation). */
function transformActive(e: ResolvedEffects | undefined): boolean {
  if (!e) return false;
  const t = e.transform;
  if (t && ((t.x ?? 0) !== 0 || (t.y ?? 0) !== 0 || (t.scale ?? 1) !== 1 || (t.rotation ?? 0) !== 0 || t.flipH || t.flipV)) {
    return true;
  }
  if (e.opacity !== undefined && e.opacity !== 1) return true;
  return hasTransformKf(e.keyframes);
}

/**
 * The geq stage that bakes the (possibly animated) transform: inverse-affine
 * sampling of the fitted layer + opacity, with out-of-canvas samples forced
 * transparent. Returns null when the clip has no transform.
 */
function transformStep(e: ResolvedEffects | undefined, W: number, H: number): string | null {
  if (!transformActive(e)) return null;
  const t = e!.transform ?? {};
  const k = e!.keyframes ?? {};
  const cx = num(W / 2);
  const cy = num(H / 2);

  const exX = kfExpr(k.x, t.x ?? 0, "T");
  const exY = kfExpr(k.y, t.y ?? 0, "T");
  const exS = kfExpr(k.scale, t.scale ?? 1, "T");
  const exR = kfExpr(k.rotation, t.rotation ?? 0, "T");
  const exO = kfExpr(k.opacity, e!.opacity ?? 1, "T");

  const TX = `((${exX})*${W})`;
  const TY = `((${exY})*${H})`;
  const TH = `((${exR})*0.0174532925)`; // degrees → radians
  const S = `max(0.0001,(${exS}))`;
  const DX = `(X-${cx}-${TX})`;
  const DY = `(Y-${cy}-${TY})`;
  const RX = `((${DX})*cos(${TH})+(${DY})*sin(${TH}))`;
  const RY = `((${DY})*cos(${TH})-(${DX})*sin(${TH}))`;
  const UX = `((${RX})/(${S}))`;
  const UY = `((${RY})/(${S}))`;
  const SRCX = t.flipH ? `(${cx}-(${UX}))` : `(${cx}+(${UX}))`;
  const SRCY = t.flipV ? `(${cy}-(${UY}))` : `(${cy}+(${UY}))`;
  const inBounds = `between(${SRCX},0,${W})*between(${SRCY},0,${H})`;

  const rgb = (fn: string) => `${fn}(${SRCX},${SRCY})`;
  // geq's alpha SAMPLING function is alpha(x,y) (the `a=` option is the alpha plane).
  const alpha = `alpha(${SRCX},${SRCY})*clip((${exO}),0,1)*${inBounds}`;
  // Each geq option value is single-quoted, so the commas inside the expressions
  // (function args, if/lt, …) are literal and keep the geq one element of the
  // comma-joined chain — same quoting the drawtext `enable=` uses.
  return `format=gbrap,geq=r='${rgb("r")}':g='${rgb("g")}':b='${rgb("b")}':a='${alpha}',format=rgba`;
}

const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Sanitize a tone-curve point string to the chars a `curves` value may contain. */
function safeCurve(pts: string): string {
  // Only digits, dot, slash and space survive — defends the filtergraph against
  // injection while keeping the documented "x/y x/y" form.
  const clean = pts.replace(/[^0-9.\/\s]/g, " ").replace(/\s+/g, " ").trim();
  return clean;
}

/**
 * Bake the richer secondary grade (white balance, lift/gamma/gain color wheels,
 * hue, tone curves) into FFmpeg filter steps. Applied AFTER the basic `eq` and
 * BEFORE any creative LUT. Each `curves` value is single-quoted so its embedded
 * spaces/slashes survive the comma-joined chain.
 */
function colorGradeSteps(grade: ColorGrade): string[] {
  const steps: string[] = [];
  const temp = grade.temperature ?? 0;
  const tint = grade.tint ?? 0;
  const wheel = (w: RGBWheel | undefined) => ({ r: w?.r ?? 0, g: w?.g ?? 0, b: w?.b ?? 0 });
  const lift = wheel(grade.lift);
  const mid = wheel(grade.gamma);
  const gain = wheel(grade.gain);
  // Fold white balance into every tonal range: warm = +red/−blue, tint = ∓green.
  const wbR = temp * 0.3;
  const wbB = -temp * 0.3;
  const wbG = -tint * 0.3;
  const cb = {
    rs: clampN(lift.r + wbR, -1, 1), gs: clampN(lift.g + wbG, -1, 1), bs: clampN(lift.b + wbB, -1, 1),
    rm: clampN(mid.r + wbR, -1, 1), gm: clampN(mid.g + wbG, -1, 1), bm: clampN(mid.b + wbB, -1, 1),
    rh: clampN(gain.r + wbR, -1, 1), gh: clampN(gain.g + wbG, -1, 1), bh: clampN(gain.b + wbB, -1, 1),
  };
  const anyCb = Object.values(cb).some((v) => Math.abs(v) > 1e-4);
  if (anyCb) {
    steps.push(
      `colorbalance=rs=${num(cb.rs)}:gs=${num(cb.gs)}:bs=${num(cb.bs)}:` +
        `rm=${num(cb.rm)}:gm=${num(cb.gm)}:bm=${num(cb.bm)}:` +
        `rh=${num(cb.rh)}:gh=${num(cb.gh)}:bh=${num(cb.bh)}`,
    );
  }
  if (grade.hue !== undefined && Math.abs(grade.hue) > 1e-4) {
    steps.push(`hue=h=${num(clampN(grade.hue, -360, 360))}`);
  }
  if (grade.curve && safeCurve(grade.curve)) steps.push(`curves=all='${safeCurve(grade.curve)}'`);
  const chan: string[] = [];
  if (grade.curveR && safeCurve(grade.curveR)) chan.push(`r='${safeCurve(grade.curveR)}'`);
  if (grade.curveG && safeCurve(grade.curveG)) chan.push(`g='${safeCurve(grade.curveG)}'`);
  if (grade.curveB && safeCurve(grade.curveB)) chan.push(`b='${safeCurve(grade.curveB)}'`);
  if (chan.length) steps.push(`curves=${chan.join(":")}`);
  return steps;
}

/**
 * Map a documented visual-effect vocabulary to FFmpeg filter strings. Unknown
 * types are skipped (the rpc layer validates/teaches the vocabulary). Operates
 * on the canvas-space RGBA stream, so effects stack after color and before the
 * 2D transform. `W`/`H` are the output canvas size (for pixelate's rescale).
 */
function effectSteps(filters: VisualEffect[], W: number, H: number): string[] {
  const out: string[] = [];
  for (const f of filters) {
    const a = f.amount;
    switch (f.type) {
      case "blur":
        out.push(`gblur=sigma=${num(clampN(a ?? 8, 0, 100))}`);
        break;
      case "sharpen":
        out.push(`unsharp=5:5:${num(clampN(a ?? 1, 0, 5))}:5:5:0`);
        break;
      case "detail": // contrast-adaptive sharpening (subtle local detail)
        out.push(`cas=strength=${num(clampN(a ?? 0.5, 0, 1))}`);
        break;
      case "denoise":
        out.push(`hqdn3d=${num(clampN(a ?? 4, 0, 30))}`);
        break;
      case "sepia":
        out.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");
        break;
      case "grayscale":
        out.push("hue=s=0");
        break;
      case "vignette":
        out.push("vignette");
        break;
      case "edges":
        out.push("edgedetect=mode=colormix");
        break;
      case "posterize": {
        const L = Math.max(1, Math.round(clampN(a ?? 6, 2, 32)) - 1);
        const e = `round(val/255*${L})/${L}*255`;
        out.push(`lutrgb=r='${e}':g='${e}':b='${e}'`);
        break;
      }
      case "pixelate": {
        const b = clampN(a ?? 16, 2, 100);
        out.push(`scale=max(2\\,iw/${num(b)}):max(2\\,ih/${num(b)}):flags=neighbor`);
        out.push(`scale=${W}:${H}:flags=neighbor`);
        break;
      }
      case "chromakey": {
        const color = (f.color ?? "0x00FF00").replace(/[^0-9a-fA-Fx#]/g, "");
        const sim = num(clampN(f.params?.similarity ?? 0.18, 0.01, 1));
        const blend = num(clampN(f.params?.blend ?? 0.1, 0, 1));
        out.push(`chromakey=${color || "0x00FF00"}:${sim}:${blend}`);
        break;
      }
      default:
        break; // unknown type: skip (validated upstream)
    }
  }
  return out;
}

/**
 * Build the per-clip video filter chain. The result is an **RGBA** stream
 * scaled to fit the canvas with TRANSPARENT letter/pillar-box padding, so when
 * it is overlaid on a lower track the background shows through the bars (true
 * layering). Fades ramp the alpha for the same reason.
 */
function videoFilterChain(clip: ResolvedRenderClip, W: number, H: number, fps: number): string {
  const fx = clip.effects ?? {};
  const speed = fx.speed ?? 1;
  const outDur = clip.outDuration;
  const steps: string[] = [];

  if (fx.crop) {
    steps.push(`crop=${Math.round(fx.crop.width)}:${Math.round(fx.crop.height)}:${Math.round(fx.crop.x)}:${Math.round(fx.crop.y)}`);
  }
  steps.push("format=rgba");
  // Lanczos is the highest-quality scaler for both up- and down-scaling real
  // footage to the canvas (sharper edges than the default bicubic, no real cost);
  // accurate_rnd + full_chroma_int keep color crisp through the resize.
  steps.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int`);
  steps.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
  steps.push("setsar=1");

  if (fx.color) {
    const c = fx.color;
    steps.push(
      `eq=brightness=${c.brightness ?? 0}:contrast=${c.contrast ?? 1}:saturation=${c.saturation ?? 1}:gamma=${c.gamma ?? 1}`,
    );
  }

  // Richer secondary grade (wheels / white balance / hue / curves) after the
  // primary eq, before the creative LUT — standard primary→creative order.
  if (fx.grade) steps.push(...colorGradeSteps(fx.grade));

  if (fx.lut) {
    // fx.lut is a render-relative bare filename (staged by the engine), since
    // absolute Windows paths can't be parsed inside a filtergraph.
    steps.push(`lut3d=${fx.lut}`);
  }

  // Creative/utility effects (blur/sharpen/key/…) after color, before transform.
  if (fx.filters?.length) steps.push(...effectSteps(fx.filters, W, H));

  // Reset timestamps and apply speed in one go.
  steps.push(`setpts=(PTS-STARTPTS)/${speed}`);
  steps.push(`fps=${fps}`);

  // Alpha fades so the layer dissolves against whatever is beneath it.
  if (fx.fadeIn && fx.fadeIn > 0) steps.push(`fade=t=in:st=0:d=${fx.fadeIn.toFixed(3)}:alpha=1`);
  if (fx.fadeOut && fx.fadeOut > 0) {
    steps.push(`fade=t=out:st=${Math.max(0, outDur - fx.fadeOut).toFixed(3)}:d=${fx.fadeOut.toFixed(3)}:alpha=1`);
  }

  // Per-clip 2D transform + keyframe animation (position/scale/rotation/flip/
  // opacity), baked before text so overlays stay in canvas space (as in preview).
  const tStep = transformStep(fx, W, H);
  if (tStep) steps.push(tStep);

  for (const ov of clip.overlays ?? []) {
    steps.push(drawTextStep(ov));
  }

  return steps.join(",");
}

/** Position expressions for an overlay, in terms of the canvas w/h and text size. */
const OVERLAY_XY: Record<string, { x: string; y: string }> = {
  top: { x: "(w-text_w)/2", y: "h*0.06" },
  center: { x: "(w-text_w)/2", y: "(h-text_h)/2" },
  bottom: { x: "(w-text_w)/2", y: "h-text_h-h*0.06" },
  topleft: { x: "w*0.05", y: "h*0.06" },
  topright: { x: "w-text_w-w*0.05", y: "h*0.06" },
  bottomleft: { x: "w*0.05", y: "h-text_h-h*0.06" },
  bottomright: { x: "w-text_w-w*0.05", y: "h-text_h-h*0.06" },
};

/** Build a single drawtext filter step for a resolved overlay. */
function drawTextStep(ov: ResolvedOverlay): string {
  // Free x/y placement (fraction of canvas, text centered on the point) wins;
  // otherwise fall back to the keyword position.
  let x: string;
  let y: string;
  if (ov.x !== undefined || ov.y !== undefined) {
    const fx = Math.min(1, Math.max(0, ov.x ?? 0.5));
    const fy = Math.min(1, Math.max(0, ov.y ?? 0.5));
    x = `(w*${fx.toFixed(4)}-text_w/2)`;
    y = `(h*${fy.toFixed(4)}-text_h/2)`;
  } else {
    const xy = OVERLAY_XY[ov.position] ?? OVERLAY_XY.bottom;
    x = xy.x;
    y = xy.y;
  }

  // Keyframe-animated position (native animated titles). drawtext's time var is
  // `t` = CLIP-LOCAL seconds (after setpts PTS-STARTPTS), matching the resolved
  // keyframe times. When x/y are animated we switch to fraction-of-canvas exprs.
  // Animated exprs carry commas (if/lt/…), so they MUST be single-quoted or the
  // filtergraph parser reads the commas as filter-chain separators.
  const kf = ov.keyframes;
  if (kf?.x?.length) x = `'(w*(${kfExpr(kf.x, ov.x ?? 0.5, "t")})-text_w/2)'`;
  if (kf?.y?.length) y = `'(h*(${kfExpr(kf.y, ov.y ?? 0.5, "t")})-text_h/2)'`;

  const parts = [
    `drawtext=textfile=${ov.textFile}`,
    `fontfile=${ov.fontFile}`,
    `fontsize=${ov.fontSize}`,
    `fontcolor=${ov.color}`,
    `x=${x}`,
    `y=${y}`,
  ];
  // Keyframe-animated opacity (fade in/out, pulses) via drawtext's alpha expr.
  if (kf?.opacity?.length) {
    parts.push(`alpha='clip(${kfExpr(kf.opacity, 1, "t")},0,1)'`);
  }
  if (ov.outlineWidth && ov.outlineWidth > 0) {
    parts.push(`borderw=${ov.outlineWidth}`, `bordercolor=${ov.outlineColor ?? "black"}`);
  }
  if ((ov.shadowX && ov.shadowX !== 0) || (ov.shadowY && ov.shadowY !== 0)) {
    parts.push(
      `shadowx=${ov.shadowX ?? 2}`,
      `shadowy=${ov.shadowY ?? 2}`,
      `shadowcolor=${ov.shadowColor ?? "black"}`,
    );
  }
  if (ov.box) parts.push("box=1", `boxcolor=${ov.boxColor}`, `boxborderw=${ov.boxBorderW ?? 12}`);
  if (ov.start !== undefined || ov.end !== undefined) {
    const start = ov.start ?? 0;
    const end = ov.end ?? 1e9;
    parts.push(`enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`);
  }
  return parts.join(":");
}

/** Build the per-clip audio filter chain for a clip that has source audio. */
function audioFilterChain(clip: ResolvedRenderClip): string {
  const fx = clip.effects ?? {};
  const speed = fx.speed ?? 1;
  const outDur = clip.outDuration;
  const steps: string[] = ["asetpts=PTS-STARTPTS"];

  if (Math.abs(speed - 1) > 1e-6) {
    for (const f of atempoFactors(speed)) steps.push(`atempo=${f}`);
  }
  // Animated volume (keyframed) takes precedence over a static gain.
  const volKf = fx.keyframes?.volume;
  if (volKf?.length) {
    steps.push(`volume=eval=frame:volume='${kfExpr(volKf, fx.volume ?? 1, "t")}'`);
  } else if (fx.volume !== undefined && Math.abs(fx.volume - 1) > 1e-6) {
    steps.push(`volume=${fx.volume}`);
  }
  // Track-level gain multiplies the clip's own volume.
  if (clip.trackVolume !== undefined && Math.abs(clip.trackVolume - 1) > 1e-6) {
    steps.push(`volume=${clip.trackVolume}`);
  }
  if (fx.fadeIn && fx.fadeIn > 0) steps.push(`afade=t=in:st=0:d=${fx.fadeIn.toFixed(3)}`);
  if (fx.fadeOut && fx.fadeOut > 0) {
    steps.push(`afade=t=out:st=${Math.max(0, outDur - fx.fadeOut).toFixed(3)}:d=${fx.fadeOut.toFixed(3)}`);
  }
  steps.push("aresample=48000:async=1");
  return steps.join(",");
}

/**
 * A run of consecutive clips on one track joined by transitions (clips that
 * overlap and whose later member carries a `transition`). Most runs are a
 * single clip. A run is rendered into ONE positioned segment: video via
 * `xfade`, audio via `acrossfade`.
 */
interface Run {
  clips: ResolvedRenderClip[];
  /** Indices into the global clip array (for stable stream labels). */
  idxs: number[];
  /** Absolute timeline start of the run, in seconds. */
  startSec: number;
  trackIndex: number;
}

/** Group a track's clips into transition-joined runs (input already sorted by start). */
function groupRuns(entries: { clip: ResolvedRenderClip; idx: number }[]): Run[] {
  const runs: Run[] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    const joins = !!e.clip.transition && last !== undefined;
    if (joins && last) {
      last.clips.push(e.clip);
      last.idxs.push(e.idx);
    } else {
      runs.push({ clips: [e.clip], idxs: [e.idx], startSec: e.clip.startSec, trackIndex: e.clip.trackIndex });
    }
  }
  return runs;
}

/** Clamp a transition overlap to what the two clip durations allow. */
function clampOverlap(want: number, prevDur: number, curDur: number, fps: number): number {
  const maxD = Math.min(prevDur, curDur) - 1 / fps;
  if (maxD < 0.05) return 0;
  return Math.min(Math.max(0, want), maxD);
}

/**
 * Build a positioned multi-track render command. Each clip is trimmed at the
 * input level, scaled/padded to the canvas, and given its per-clip effects.
 * Clips are grouped into transition runs (xfade/acrossfade), and every run is
 * placed at its absolute start: video runs are overlaid bottom-track-first onto
 * a black canvas (higher Track.index composites on top); audio runs are delayed
 * to their start and mixed. Background music is mixed/ducked last.
 */
/**
 * Resolve export encoding settings into ffmpeg output args. Container is taken
 * from the settings or inferred from the output extension; webm forces vp9/opus.
 */
export function exportCodecArgs(
  settings: ExportSettings | undefined,
  profile: RenderProfile,
  outputPath: string,
): string[] {
  const ext = (outputPath.split(".").pop() ?? "").toLowerCase();
  const container = settings?.container ?? (ext === "webm" ? "webm" : ext === "mov" ? "mov" : "mp4");
  const isWebm = container === "webm";
  const vcodec = settings?.videoCodec ?? (isWebm ? "vp9" : "h264");
  const acodec = settings?.audioCodec ?? (isWebm ? "opus" : "aac");

  const vlib = vcodec === "h265" ? "libx265" : vcodec === "vp9" ? "libvpx-vp9" : "libx264";
  const alib = acodec === "opus" ? "libopus" : "aac";
  // CRF scales differ per codec; pick a sensible default if none given.
  const defaultCrf = vcodec === "vp9" ? 32 : vcodec === "h265" ? 24 : profile.crf;
  const crf = settings?.quality ?? defaultCrf;

  const args: string[] = ["-c:v", vlib];
  if (vcodec !== "vp9") args.push("-preset", settings?.preset ?? profile.preset);
  if (settings?.videoBitrate) args.push("-b:v", settings.videoBitrate);
  else args.push("-crf", String(crf), ...(vcodec === "vp9" ? ["-b:v", "0"] : []));
  args.push("-pix_fmt", "yuv420p", "-c:a", alib, "-b:a", settings?.audioBitrate ?? profile.audioBitrate);
  // faststart only helps the mp4/mov atom layout; webm doesn't use it.
  if (!isWebm) args.push("-movflags", "+faststart");
  return args;
}

export function buildRenderCommand(
  clips: ResolvedRenderClip[],
  canvas: Canvas,
  outputPath: string,
  profile: RenderProfile,
  music?: ResolvedMusic,
  settings?: ExportSettings,
): RenderCommand {
  if (clips.length === 0) {
    throw new Error("Cannot render an empty timeline — add at least one clip.");
  }

  const W = even(canvas.width);
  const H = even(canvas.height);
  const fps = canvas.fps;

  // Total timeline length: the furthest video OR audio extent.
  let total = 0;
  for (const c of clips) {
    total = Math.max(total, c.startSec + c.outDuration);
    const aShift = c.audioOffset && c.audioOffset > 0 ? c.audioOffset : 0;
    if (c.hasAudio) total = Math.max(total, c.startSec + aShift + c.outDuration);
  }
  total = Math.max(total, 1 / fps);

  const inputArgs: string[] = [];
  // File inputs (one per clip), trimmed at the input level for fast seeking.
  // A still image has no timeline to seek — loop the single frame at the canvas
  // fps for the clip's duration so it behaves like any other footage.
  clips.forEach((clip) => {
    if (clip.isImage) {
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", clip.outDuration.toFixed(6), "-i", clip.path);
    } else {
      inputArgs.push("-ss", clip.sourceIn.toFixed(6), "-t", clip.sourceSpan.toFixed(6), "-i", clip.path);
    }
  });
  let nextIndex = clips.length;

  // Motion-graphic overlay inputs: one alpha video per graphic, composited over
  // its owning clip within a window (absolute paths fine — referenced by index).
  const graphicInputs: { clipIdx: number; inputIdx: number; g: ResolvedGraphic }[] = [];
  clips.forEach((clip, i) => {
    for (const g of clip.graphics ?? []) {
      inputArgs.push("-i", g.path);
      graphicInputs.push({ clipIdx: i, inputIdx: nextIndex++, g });
    }
  });

  const filterParts: string[] = [];

  // ---- per-clip base streams ------------------------------------------------
  clips.forEach((clip, i) => {
    if (clip.showVideo) {
      const graphicsForClip = graphicInputs.filter((x) => x.clipIdx === i);
      const baseLabel = graphicsForClip.length ? `vbase${i}` : `v${i}`;
      filterParts.push(`[${i}:v]${videoFilterChain(clip, W, H, fps)}[${baseLabel}]`);

      if (graphicsForClip.length) {
        let cur = `[${baseLabel}]`;
        graphicsForClip.forEach((gi, k) => {
          const start = Math.max(0, gi.g.start ?? 0);
          const end = gi.g.end ?? 1e9;
          const gl = `g${i}_${k}`;
          const prep = [`[${gi.inputIdx}:v]format=rgba`, `scale=${W}:${H}`, `fps=${fps}`];
          if (gi.g.opacity !== undefined && gi.g.opacity < 1) {
            prep.push(`colorchannelmixer=aa=${Math.max(0, Math.min(1, gi.g.opacity)).toFixed(3)}`);
          }
          if (start > 1e-3) prep.push(`tpad=start_duration=${start.toFixed(3)}:color=0x00000000`);
          prep.push("setpts=PTS-STARTPTS");
          filterParts.push(`${prep.join(",")}[${gl}]`);

          const isLast = k === graphicsForClip.length - 1;
          const out = isLast ? `v${i}` : `vov${i}_${k}`;
          const enable = `enable='between(t,${start.toFixed(3)},${end >= 1e9 ? "1e9" : end.toFixed(3)})'`;
          filterParts.push(`${cur}[${gl}]overlay=0:0:eof_action=pass:${enable}[${out}]`);
          cur = `[${out}]`;
        });
      }
    }
    if (clip.hasAudio && !clip.muted) {
      filterParts.push(`[${i}:a]${audioFilterChain(clip)}[a${i}]`);
    }
  });

  // ---- group clips into per-track transition runs ---------------------------
  const byTrack = new Map<number, { clip: ResolvedRenderClip; idx: number }[]>();
  clips.forEach((clip, idx) => {
    const list = byTrack.get(clip.trackIndex) ?? [];
    list.push({ clip, idx });
    byTrack.set(clip.trackIndex, list);
  });
  const videoRuns: Run[] = [];
  const audioRuns: Run[] = [];
  for (const [, list] of byTrack) {
    list.sort((a, b) => a.clip.startSec - b.clip.startSec);
    const runs = groupRuns(list);
    for (const run of runs) {
      if (run.clips.some((c) => c.showVideo)) videoRuns.push(run);
      if (run.clips.some((c) => c.hasAudio && !c.muted)) audioRuns.push(run);
    }
  }

  // ---- video: assemble each run, then overlay onto a black base in z-order ---
  const videoSegments: { label: string; startSec: number; dur: number; trackIndex: number }[] = [];
  videoRuns.forEach((run, r) => {
    let cur = `[v${run.idxs[0]}]`;
    let curDur = run.clips[0].outDuration;
    for (let i = 1; i < run.clips.length; i++) {
      const clip = run.clips[i];
      const d = clampOverlap(clip.transition?.duration ?? 0, curDur, clip.outDuration, fps);
      const out = `vrun${r}_${i}`;
      if (d > 0) {
        filterParts.push(
          `${cur}[v${run.idxs[i]}]xfade=transition=${clip.transition!.type}:duration=${d.toFixed(3)}:offset=${(curDur - d).toFixed(3)}[${out}]`,
        );
      } else {
        // No usable overlap: hard concat the two run members.
        filterParts.push(`${cur}[v${run.idxs[i]}]concat=n=2:v=1:a=0[${out}]`);
      }
      cur = `[${out}]`;
      curDur = curDur + clip.outDuration - d;
    }
    videoSegments.push({ label: cur, startSec: run.startSec, dur: curDur, trackIndex: run.trackIndex });
  });

  // Bottom→top: lower Track.index first so higher tracks overlay on top.
  videoSegments.sort((a, b) => a.trackIndex - b.trackIndex || a.startSec - b.startSec);

  filterParts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total.toFixed(6)},format=rgba[vbase]`);
  let vcur = "[vbase]";
  videoSegments.forEach((seg, i) => {
    const start = seg.startSec;
    const end = start + seg.dur;
    let s = seg.label;
    if (start > 1e-3) {
      const padded = `vpad${i}`;
      filterParts.push(`${s}tpad=start_duration=${start.toFixed(3)}:color=0x00000000,setpts=PTS-STARTPTS[${padded}]`);
      s = `[${padded}]`;
    }
    const out = `vstack${i}`;
    const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    filterParts.push(`${vcur}${s}overlay=0:0:eof_action=pass:${enable}[${out}]`);
    vcur = `[${out}]`;
  });
  filterParts.push(`${vcur}trim=0:${total.toFixed(6)},format=yuv420p[outv]`);

  // ---- audio: assemble each run, delay to its start, mix --------------------
  const audioLabels: string[] = [];
  // Silent base guarantees a valid mix even if nothing has audio.
  inputArgs.push("-f", "lavfi", "-t", total.toFixed(6), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  const silenceIdx = nextIndex++;
  filterParts.push(`[${silenceIdx}:a]asetpts=PTS-STARTPTS[abase]`);
  audioLabels.push("[abase]");

  audioRuns.forEach((run, r) => {
    const members = run.clips
      .map((clip, i) => ({ clip, idx: run.idxs[i] }))
      .filter((m) => m.clip.hasAudio && !m.clip.muted);
    if (members.length === 0) return;
    let cur = `[a${members[0].idx}]`;
    for (let i = 1; i < members.length; i++) {
      const d = clampOverlap(members[i].clip.transition?.duration ?? 0, members[i - 1].clip.outDuration, members[i].clip.outDuration, fps);
      const out = `arun${r}_${i}`;
      if (d > 0) {
        filterParts.push(`${cur}[a${members[i].idx}]acrossfade=d=${d.toFixed(3)}[${out}]`);
      } else {
        filterParts.push(`${cur}[a${members[i].idx}]concat=n=2:v=0:a=1[${out}]`);
      }
      cur = `[${out}]`;
    }
    // Place at the run start; for a single clip also apply its audio slip (J/L).
    const offset = run.clips.length === 1 ? run.clips[0].audioOffset ?? 0 : 0;
    const startMs = Math.round(Math.max(0, run.startSec + offset) * 1000);
    if (startMs > 0) {
      const out = `ad${r}`;
      filterParts.push(`${cur}adelay=${startMs}:all=1[${out}]`);
      cur = `[${out}]`;
    }
    audioLabels.push(cur);
  });

  filterParts.push(
    `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixraw]`,
  );
  filterParts.push(`[amixraw]apad,atrim=0:${total.toFixed(6)},aresample=48000[paud]`);

  // ---- background music -----------------------------------------------------
  let audioOut = "[paud]";
  if (music) {
    const mIdx = nextIndex++;
    inputArgs.push("-stream_loop", "-1", "-t", total.toFixed(6), "-i", music.path);
    const mSteps = ["asetpts=PTS-STARTPTS", "aresample=48000", `volume=${music.volume}`];
    if (music.fadeIn && music.fadeIn > 0) mSteps.push(`afade=t=in:st=0:d=${music.fadeIn.toFixed(3)}`);
    if (music.fadeOut && music.fadeOut > 0) {
      mSteps.push(`afade=t=out:st=${Math.max(0, total - music.fadeOut).toFixed(3)}:d=${music.fadeOut.toFixed(3)}`);
    }
    filterParts.push(`[${mIdx}:a]${mSteps.join(",")}[mraw]`);
    if (music.duck) {
      filterParts.push(`[paud]asplit=2[pmix][pside]`);
      filterParts.push(`[mraw][pside]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300:level_sc=1[mduck]`);
      filterParts.push(`[pmix][mduck]amix=inputs=2:duration=first:normalize=0[outa]`);
    } else {
      filterParts.push(`[paud][mraw]amix=inputs=2:duration=first:normalize=0[outa]`);
    }
    audioOut = "[outa]";
  }

  const filterComplex = filterParts.join(";");

  const args: string[] = [
    "-hide_banner",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    audioOut,
    ...exportCodecArgs(settings, profile, outputPath),
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
    outputPath,
  ];

  return { args, totalDuration: total };
}

/** Build an ffmpeg command that extracts a single thumbnail frame from a source. */
export function buildThumbnailCommand(
  sourcePath: string,
  atSeconds: number,
  outputPath: string,
  width = 320,
): string[] {
  return [
    "-hide_banner",
    "-ss",
    Math.max(0, atSeconds).toFixed(3),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2:force_original_aspect_ratio=decrease`,
    "-q:v",
    "3",
    "-y",
    outputPath,
  ];
}

export type { ClipEffects, ResolvedEffects };
