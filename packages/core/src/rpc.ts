import { z } from "zod";
import type { EditorEngine } from "./engine.js";
import { clipDurationFrames, clipEndFrame } from "./types.js";
import { WHISPER_MODELS } from "./whisper/setup.js";
import { GRAPHIC_TEMPLATES, GRAPHIC_TEMPLATE_NAMES } from "./motion/templates.js";
import { EXPORT_PRESETS, EXPORT_PRESET_NAMES } from "./ffmpeg/graph.js";

/**
 * The RPC surface of the editor. Every editing operation is defined exactly
 * once here as a `{ schema, handler }` pair, then exposed through two
 * transports: the WebSocket server (for the desktop UI) and the MCP server
 * (for the AI). This guarantees the AI and the human drive the *same* engine
 * through the *same* validated commands.
 *
 * The timeline is multi-track and FRAME-BASED. Every position/duration param is
 * an integer count of project frames (the project runs at `fps` frames/sec).
 * Tracks are addressed by `trackIndex` (their stable stacking index); clips by
 * `clipId`. Among video tracks, a higher index composites ON TOP of lower.
 */

export interface RpcMethod<S extends z.ZodTypeAny = z.ZodTypeAny> {
  description: string;
  schema: S;
  handler: (engine: EditorEngine, params: z.infer<S>) => unknown | Promise<unknown>;
}

const empty = z.object({}).strict();

/**
 * Is `value` a color FFmpeg's drawtext/filters accept? That's a named color
 * ("white", "red", "random"), #RRGGBB[AA] / 0xRRGGBB[AA] hex, optionally with an
 * `@alpha` (0..1) suffix (e.g. "black@0.5"). CSS forms like rgb()/rgba()/hsl()
 * are NOT valid here — they don't parse and crash the whole filtergraph at
 * render time with an opaque error, so we reject them up front instead.
 */
function isFfmpegColor(value: string): boolean {
  const [name, alpha, ...rest] = value.trim().split("@");
  if (rest.length > 0 || !name) return false;
  if (alpha !== undefined) {
    const a = Number(alpha);
    if (!Number.isFinite(a) || a < 0 || a > 1) return false;
  }
  // #RRGGBB(AA) or 0xRRGGBB(AA) hex, or a bare color name (letters only).
  return /^(?:#|0x)?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(name) || /^[a-zA-Z]+$/.test(name);
}

/** A reusable FFmpeg-color string field that rejects CSS colors with a teaching message. */
const colorField = z
  .string()
  .refine(isFfmpegColor, (v) => ({
    message:
      `Invalid color "${v}". Use an FFmpeg color: a name like "white"/"red", ` +
      `#RRGGBB or 0xRRGGBB hex, or name@alpha like "black@0.5". ` +
      `CSS rgb()/rgba()/hsl() are not supported.`,
  }));

/**
 * The open text-styling vocabulary, shared by text overlays and captions. None
 * of it is an enum — the AI composes whatever look it wants. `font` is any
 * installed family name or an absolute path to a .ttf/.otf; colors are FFmpeg
 * colors (a name, #RRGGBB, or name@alpha); `position` is a keyword OR use x/y
 * (0..1 fractions of the frame).
 */
const TEXT_STYLE_FIELDS = {
  position: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  font: z.string().optional(),
  fontSize: z.number().int().positive().max(400).optional(),
  color: colorField.optional(),
  outlineColor: colorField.optional(),
  outlineWidth: z.number().min(0).max(40).optional(),
  shadowColor: colorField.optional(),
  shadowX: z.number().min(-40).max(40).optional(),
  shadowY: z.number().min(-40).max(40).optional(),
  box: z.boolean().optional(),
  boxColor: colorField.optional(),
  boxBorderW: z.number().int().min(0).max(200).optional(),
};

const TRANSITION_TYPES = [
  "fade",
  "dissolve",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "circleopen",
  "circleclose",
  "fadeblack",
  "fadewhite",
  "radial",
  "smoothleft",
  "smoothright",
] as const;

const KEYFRAME_PROPERTIES = ["x", "y", "scale", "rotation", "opacity", "volume"] as const;
const EASE_KINDS = ["linear", "hold", "ease", "easeIn", "easeOut"] as const;
/** The documented visual-effect vocabulary (each maps to an FFmpeg filter in graph.ts). */
const EFFECT_TYPES = [
  "blur", "sharpen", "detail", "denoise", "sepia", "grayscale",
  "vignette", "edges", "posterize", "pixelate", "chromakey",
] as const;

function summarizeTimeline(engine: EditorEngine) {
  const project = engine.getProject();
  const tracks = [...project.tracks]
    .sort((a, b) => a.index - b.index)
    .map((track) => ({
      trackIndex: track.index,
      kind: track.kind,
      name: track.name,
      muted: track.muted ?? false,
      hidden: track.hidden ?? false,
      locked: track.locked ?? false,
      clips: track.clips.map((clip) => {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        return {
          clipId: clip.id,
          assetId: clip.assetId,
          asset: asset?.name ?? "(missing)",
          startFrame: clip.startFrame,
          durationFrames: clipDurationFrames(clip),
          endFrame: clipEndFrame(clip),
          sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceOutFrame,
          transition: clip.transition,
          effects: clip.effects ?? undefined,
          linkGroupId: clip.linkGroupId,
        };
      }),
    }));
  return {
    name: project.name,
    projectFile: engine.getCurrentPath() ?? null,
    unsavedChanges: engine.isDirty(),
    canvas: { width: project.width, height: project.height, fps: project.fps },
    fps: project.fps,
    totalFrames: engine.timelineDurationFrames(),
    totalDuration: Number(engine.timelineDuration().toFixed(3)),
    trackCount: project.tracks.length,
    tracks,
  };
}

const clipPlacement = {
  trackIndex: z.number().int().min(0).optional(),
  startFrame: z.number().int().min(0).optional(),
  sourceInFrame: z.number().int().min(0).optional(),
  sourceOutFrame: z.number().int().min(0).optional(),
};

export const methods = {
  get_state: {
    description: "Return the full current project state (assets, tracks, clips, canvas). All timing is in frames.",
    schema: empty,
    handler: (engine) => engine.getProject(),
  },

  timeline_summary: {
    description:
      "Return a compact, human-readable summary of the multi-track timeline: tracks (with stacking trackIndex, kind, mute/hide/lock), and per-clip frame positions/durations. Prefer this over get_state when reasoning about the edit. Times are in frames; the canvas carries fps.",
    schema: empty,
    handler: (engine) => summarizeTimeline(engine),
  },

  inspect_timeline: {
    description:
      "THE VISION LOOP in one call: returns the timeline_summary (structure, in frames) AND a freshly rendered composited frame image at `atSeconds` (defaults to the midpoint) so you SEE the actual result. Call this after a batch of visual edits to verify structure + look together, then continue or fix.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ summary: summarizeTimeline(engine), frame: await engine.renderFrame(p.atSeconds) }),
  },

  import_video: {
    description:
      "Import a local media file into the project library by absolute path. Probes it with ffprobe and returns its metadata (duration, resolution, fps, audio).",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => ({ asset: await engine.importVideo(p.path) }),
  },

  remove_asset: {
    description: "Remove an asset from the library and delete any clips that reference it.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeAsset(p.assetId);
      return { ok: true };
    },
  },

  // ---- tracks ---------------------------------------------------------------
  add_track: {
    description:
      "Add a new track. kind 'video' (stacks on top of existing video tracks — higher trackIndex composites OVER lower) or 'audio'. Returns the new track's trackIndex.",
    schema: z
      .object({ kind: z.enum(["video", "audio"]), name: z.string().optional(), height: z.number().int().positive().optional() })
      .strict(),
    handler: (engine, p) => {
      const t = engine.addTrack(p.kind, { name: p.name, height: p.height });
      return { trackIndex: t.index, id: t.id, kind: t.kind, name: t.name };
    },
  },

  remove_track: {
    description: "Remove a track (and all its clips) by trackIndex. The last video track cannot be removed.",
    schema: z.object({ trackIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => {
      engine.removeTrack(p.trackIndex);
      return { ok: true };
    },
  },

  reorder_track: {
    description:
      "Change a track's stacking position (z-order). newIndex is the target slot among tracks; indices are re-packed afterwards. Higher final trackIndex composites on top for video.",
    schema: z.object({ trackIndex: z.number().int().min(0), newIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => {
      engine.reorderTrack(p.trackIndex, p.newIndex);
      return { ok: true };
    },
  },

  set_track_properties: {
    description:
      "Update a track: name, muted (drop its audio from the mix), volume (track audio gain multiplier, 1 = unchanged), hidden (exclude its picture from the composite), locked (UI edit-lock), and display height. Only the fields you pass change.",
    schema: z
      .object({
        trackIndex: z.number().int().min(0),
        name: z.string().optional(),
        muted: z.boolean().optional(),
        volume: z.number().min(0).optional(),
        hidden: z.boolean().optional(),
        locked: z.boolean().optional(),
        height: z.number().int().positive().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { trackIndex, ...patch } = p;
      const t = engine.setTrackProperties(trackIndex, patch);
      return { trackIndex: t.index, name: t.name, muted: t.muted, volume: t.volume, hidden: t.hidden, locked: t.locked };
    },
  },

  // ---- clip placement -------------------------------------------------------
  add_clip: {
    description:
      "Place a clip on the timeline. Defaults: base (bottom) video track, appended after the last clip, whole asset. Set trackIndex to target a track (e.g. an overlay video track or an audio track), startFrame for an absolute position (gaps allowed), and sourceInFrame/sourceOutFrame to use only part of the asset.",
    schema: z.object({ assetId: z.string(), ...clipPlacement }).strict(),
    handler: (engine, p) => ({ clip: engine.addClip(p.assetId, p) }),
  },

  add_clips: {
    description:
      "Place several clips in one undoable step. Each item is { assetId, trackIndex?, startFrame?, sourceInFrame?, sourceOutFrame? } with the same defaults as add_clip. Use this to lay down a whole sequence or stack overlays at once.",
    schema: z
      .object({
        clips: z
          .array(z.object({ assetId: z.string(), ...clipPlacement }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => ({ clips: engine.addClips(p.clips) }),
  },

  append_clip: {
    description:
      "Convenience: append a clip to the end of the base video track. Optionally sourceInFrame/sourceOutFrame to use part of the asset. (For positioned/multi-track placement use add_clip.)",
    schema: z
      .object({ assetId: z.string(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.appendClip(p.assetId, p.sourceInFrame, p.sourceOutFrame) }),
  },

  insert_clip: {
    description:
      "Insert a clip at startFrame on a track, rippling later clips on that track to the right by the inserted footprint (nothing is overwritten). Defaults to the base video track.",
    schema: z
      .object({ assetId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.insertClip(p.assetId, p) }),
  },

  move_clip: {
    description:
      "Move a clip to an absolute startFrame, optionally onto another track (trackIndex). Linked clips move together. Any entering transition on the moved clip is cleared.",
    schema: z.object({ clipId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional() }).strict(),
    handler: (engine, p) => {
      engine.moveClip(p.clipId, p.startFrame, p.trackIndex);
      return { ok: true };
    },
  },

  move_clips: {
    description: "Move several clips at once. Each item is { clipId, startFrame, trackIndex? }.",
    schema: z
      .object({
        moves: z
          .array(z.object({ clipId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional() }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => {
      engine.moveClips(p.moves);
      return { ok: true };
    },
  },

  trim_clip: {
    description: "Re-trim a clip by setting new sourceInFrame and/or sourceOutFrame (frames within the source asset). The clip's start position is unchanged.",
    schema: z
      .object({ clipId: z.string(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.trimClip(p.clipId, p.sourceInFrame, p.sourceOutFrame) }),
  },

  split_clip: {
    description: "Split a clip into two at `atFrame`, measured in frames from the clip's start on the timeline. Linked clips split at the same point.",
    schema: z.object({ clipId: z.string(), atFrame: z.number().int().positive() }).strict(),
    handler: (engine, p) => engine.splitClip(p.clipId, p.atFrame),
  },

  cut_range: {
    description:
      "Remove a section [startFrame, endFrame) from within a clip (frames from the clip's start). The footage to the right and all later clips on that track close up (ripple left). The 'cut the boring part' operation.",
    schema: z.object({ clipId: z.string(), startFrame: z.number().int().min(0), endFrame: z.number().int().positive() }).strict(),
    handler: (engine, p) => ({ clips: engine.cutRange(p.clipId, p.startFrame, p.endFrame) }),
  },

  ripple_delete_ranges: {
    description:
      "Delete one or more timeline frame ranges and close the gaps (shift later clips left). Each range is { trackIndex, startFrame, endFrame }. Useful for cutting dead air across the timeline in one pass.",
    schema: z
      .object({
        ranges: z
          .array(z.object({ trackIndex: z.number().int().min(0), startFrame: z.number().int().min(0), endFrame: z.number().int().positive() }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => {
      engine.rippleDeleteRanges(p.ranges);
      return { ok: true };
    },
  },

  remove_clip: {
    description: "Delete a clip from the timeline (linked clips are removed together).",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeClip(p.clipId);
      return { ok: true };
    },
  },

  link_clips: {
    description:
      "Link clips (e.g. a video clip and its detached audio on another track) so they move/trim/split/delete together. Returns the link group id.",
    schema: z.object({ clipIds: z.array(z.string()).min(2) }).strict(),
    handler: (engine, p) => ({ linkGroupId: engine.linkClips(p.clipIds) }),
  },

  unlink_clip: {
    description: "Unlink a clip (and its whole link group) so they move independently again.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.unlinkClip(p.clipId);
      return { ok: true };
    },
  },

  // ---- per-clip effects -----------------------------------------------------
  set_clip_speed: {
    description:
      "Change a clip's playback speed (0.25..4; 1 = normal, 2 = 2x faster, 0.5 = slow motion). Adjusts video, audio, and the clip's timeline footprint.",
    schema: z.object({ clipId: z.string(), speed: z.number().min(0.25).max(4) }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { speed: p.speed }) }),
  },

  set_clip_volume: {
    description: "Set a clip's audio volume (1 = unchanged, 0 = mute, 1.5 = +50%).",
    schema: z.object({ clipId: z.string(), volume: z.number().min(0) }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { volume: p.volume }) }),
  },

  set_clip_fade: {
    description: "Set fade-in and/or fade-out durations (in FRAMES) for a clip. Applies to both video (alpha) and audio.",
    schema: z
      .object({ clipId: z.string(), fadeInFrames: z.number().int().min(0).optional(), fadeOutFrames: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { fadeInFrames: p.fadeInFrames, fadeOutFrames: p.fadeOutFrames }) }),
  },

  color_grade: {
    description:
      "Apply a color grade to a clip. brightness -1..1 (0=unchanged), contrast 0..3 (1=unchanged), saturation 0..3 (1=unchanged), gamma 0.1..10 (1=unchanged).",
    schema: z
      .object({
        clipId: z.string(),
        brightness: z.number().min(-1).max(1).optional(),
        contrast: z.number().min(0).max(3).optional(),
        saturation: z.number().min(0).max(3).optional(),
        gamma: z.number().min(0.1).max(10).optional(),
      })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipEffects(p.clipId, {
        color: { brightness: p.brightness, contrast: p.contrast, saturation: p.saturation, gamma: p.gamma },
      }),
    }),
  },

  crop_clip: {
    description:
      "Crop a clip to a source-pixel rectangle (x, y, width, height), e.g. to reframe widescreen footage for vertical output. Combine with set_project_settings to set the output aspect ratio.",
    schema: z
      .object({ clipId: z.string(), x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipEffects(p.clipId, { crop: { x: p.x, y: p.y, width: p.width, height: p.height } }),
    }),
  },

  apply_lut: {
    description: "Apply a 3D LUT (.cube file, absolute path) to a clip for a cinematic color look. Combine with color_grade for fine-tuning.",
    schema: z.object({ clipId: z.string(), path: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { lut: p.path }) }),
  },

  apply_color: {
    description:
      "Apply a RICHER secondary color grade to a clip (runs after color_grade's eq, before any LUT). Only the fields you pass change; wheels are merged channel-by-channel. WHITE BALANCE: temperature -1..1 (+warm/redder, −cool/bluer), tint -1..1 (+magenta, −green). hue = global hue rotation in degrees (-180..180). COLOR WHEELS (3-way corrector), each an object {r,g,b} of -1..1 offsets: lift = shadows, gamma = midtones, gain = highlights (e.g. lift:{b:0.1} lifts shadows toward blue for a teal-shadow look). TONE CURVES as space-separated x/y points in 0..1: curve = master/luma (e.g. '0/0 0.25/0.18 0.75/0.85 1/1' for an S-curve / more contrast); curveR/curveG/curveB = per-channel. Combine with apply_lut for a creative look on top. Use inspect_color afterward to verify objectively.",
    schema: z
      .object({
        clipId: z.string(),
        temperature: z.number().min(-1).max(1).optional(),
        tint: z.number().min(-1).max(1).optional(),
        hue: z.number().min(-180).max(180).optional(),
        lift: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        gamma: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        gain: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        curve: z.string().optional(),
        curveR: z.string().optional(),
        curveG: z.string().optional(),
        curveB: z.string().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { clipId, ...grade } = p;
      return { clip: engine.setClipGrade(clipId, grade) };
    },
  },

  apply_effect: {
    description:
      "Add a creative/utility visual EFFECT to a clip (baked as an FFmpeg filter, in order, after color). Effects stack — call repeatedly. type is one of: blur (gaussian; amount = sigma ~0..100), sharpen (amount ~0..5), detail (contrast-adaptive micro-sharpen; amount 0..1), denoise (amount ~0..30), sepia, grayscale, vignette, edges (edge-detect look), posterize (amount = color levels 2..32), pixelate (amount = block factor 2..100), chromakey (key out a color to transparency so a lower track shows through — pass color e.g. '0x00FF00' and params {similarity,blend}). Pass effectId to UPDATE an existing effect in place. Returns the effectId (use remove_effect to delete it).",
    schema: z
      .object({
        clipId: z.string(),
        type: z.enum(EFFECT_TYPES),
        amount: z.number().optional(),
        color: z.string().optional(),
        params: z.record(z.number()).optional(),
        effectId: z.string().optional(),
      })
      .strict(),
    handler: (engine, p) => engine.applyEffect(p.clipId, { id: p.effectId, type: p.type, amount: p.amount, color: p.color, params: p.params }),
  },

  remove_effect: {
    description: "Remove one visual effect from a clip by its effectId (from apply_effect). To clear ALL effects/color at once use clear_clip_effects.",
    schema: z.object({ clipId: z.string(), effectId: z.string() }).strict(),
    handler: (engine, p) => ({ clip: engine.removeEffect(p.clipId, p.effectId) }),
  },

  inspect_color: {
    description:
      "Measure the color of the CURRENT composited timeline at `atSeconds` (defaults to the midpoint) — your color EYES. Returns numeric scopes: luma {min,avg,max,contrast}, saturation {avg,max}, hue {avg}, mean rgb {r,g,b} (all 0..255), plus plain-language `notes` (e.g. 'warm color cast', 'low contrast'), AND three rendered scope IMAGES (histogram, waveform, vectorscope) as file paths you can view. Call after color_grade/apply_color/apply_lut to verify the grade objectively instead of guessing.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => engine.inspectColor(p.atSeconds),
  },

  stabilize_clip: {
    description:
      "Stabilize shaky footage in a clip using two-pass analysis. Bakes a stabilized copy and re-points the clip at it (other effects preserved). May take a while for long clips.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: async (engine, p) => ({ clip: await engine.stabilizeClip(p.clipId) }),
  },

  auto_reframe: {
    description:
      "Reframe a clip to the project's output aspect ratio (e.g. 16:9 → 9:16) while keeping the main person in frame, using local face tracking (YuNet). Bakes a smoothed moving crop and re-points the clip. Set the project to the target aspect with set_project_settings first. Returns tracking stats (hitRate).",
    schema: z
      .object({
        clipId: z.string(),
        sampleFps: z.number().positive().max(15).optional(),
        smoothing: z.number().min(0.01).max(1).optional(),
        scoreThreshold: z.number().min(0.1).max(0.99).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const r = await engine.autoReframe(p.clipId, { sampleFps: p.sampleFps, smoothing: p.smoothing, scoreThreshold: p.scoreThreshold });
      return { clipId: r.clip.id, hitRate: Number(r.hitRate.toFixed(3)), cropWidth: r.cropWidth, cropHeight: r.cropHeight, keyframes: r.keyframes };
    },
  },

  clear_clip_effects: {
    description: "Remove all effects (speed, volume, fades, color, crop, transform) from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearClipEffects(p.clipId);
      return { ok: true };
    },
  },

  // ---- per-clip transform + keyframe animation ------------------------------
  set_clip_transform: {
    description:
      "Position/scale/rotate a clip's picture within the output canvas (after it's fit to the canvas). x,y = offset as a FRACTION of canvas width/height (0 = centered, +x right, +y down; e.g. x:0.25 nudges a quarter-width right). scale = multiplier (1 = fit, 0.5 = half-size picture-in-picture, 2 = zoom in). rotation = degrees clockwise. flipH/flipV = mirror. opacity = 0..1. Only the fields you pass change; pass {} fields to leave others. Combine with set_keyframes to ANIMATE any of x/y/scale/rotation/opacity over time.",
    schema: z
      .object({
        clipId: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        scale: z.number().min(0.01).max(16).optional(),
        rotation: z.number().optional(),
        flipH: z.boolean().optional(),
        flipV: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
      })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipTransform(p.clipId, {
        transform: { x: p.x, y: p.y, scale: p.scale, rotation: p.rotation, flipH: p.flipH, flipV: p.flipV },
        opacity: p.opacity,
      }),
    }),
  },

  set_keyframes: {
    description:
      "Animate one property of a clip over time by setting its keyframes (REPLACES that property's track; pass an empty list to clear it). property: x | y | scale | rotation | opacity | volume (x/y are canvas fractions, scale a multiplier, rotation degrees, opacity & volume 0..1+). Each keyframe = { frame, value, ease? } where `frame` is CLIP-LOCAL (0 = the clip's start) and `ease` (linear|hold|ease|easeIn|easeOut) describes the interpolation INTO that keyframe (default linear; 'hold' = step). Example — a clip flying in from the left while scaling up: set_keyframes(clipId,'x',[{frame:0,value:-0.5},{frame:15,value:0,ease:'easeOut'}]) and set_keyframes(clipId,'scale',[{frame:0,value:0.6},{frame:15,value:1,ease:'easeOut'}]).",
    schema: z
      .object({
        clipId: z.string(),
        property: z.enum(KEYFRAME_PROPERTIES),
        keyframes: z
          .array(
            z.object({ frame: z.number().int().min(0), value: z.number(), ease: z.enum(EASE_KINDS).optional() }).strict(),
          )
          .max(200),
      })
      .strict(),
    handler: (engine, p) => ({ clip: engine.setKeyframes(p.clipId, p.property, p.keyframes) }),
  },

  clear_keyframes: {
    description: "Remove keyframe animation from a clip — one property (x/y/scale/rotation/opacity/volume) if given, otherwise all of them.",
    schema: z.object({ clipId: z.string(), property: z.enum(KEYFRAME_PROPERTIES).optional() }).strict(),
    handler: (engine, p) => {
      engine.clearKeyframes(p.clipId, p.property);
      return { ok: true };
    },
  },

  set_transition: {
    description:
      "Add a crossfade/transition entering a clip from the previous clip on the SAME track. The two clips overlap by `durationFrames` and crossfade over that overlap (the clip and everything after it on the track is pulled left to create the overlap). Cannot be set on a track's first clip. Use 'fade'/'dissolve' for a classic crossfade.",
    schema: z.object({ clipId: z.string(), type: z.enum(TRANSITION_TYPES), durationFrames: z.number().int().positive().max(300) }).strict(),
    handler: (engine, p) => ({ clip: engine.setTransition(p.clipId, p.type, p.durationFrames) }),
  },

  remove_transition: {
    description: "Remove the transition entering a clip (revert to a hard cut; the clip butts against the previous one again).",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeTransition(p.clipId);
      return { ok: true };
    },
  },

  set_audio_offset: {
    description:
      "Create a J-cut or L-cut by sliding a clip's audio relative to its video, in FRAMES. NEGATIVE = audio leads the picture (J-cut: heard before seen — set on the INCOMING clip). POSITIVE = audio trails (L-cut: this clip's audio runs late over the next clip). Pass 0 to re-lock. These overlapping-audio edits make cuts feel seamless.",
    schema: z.object({ clipId: z.string(), offsetFrames: z.number().int() }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipAudioOffset(p.clipId, p.offsetFrames) }),
  },

  // ---- text & captions ------------------------------------------------------
  add_text: {
    description:
      "Add a burned-in text overlay (title, lower-third, kinetic word, label) to a clip. Compose the look freely with the style fields: any installed `font` or a font-file path, fontSize/color, outline (outlineColor+outlineWidth), drop shadow (shadowColor+shadowX/shadowY), background box, and placement via keyword `position` or x/y (0..1). startFrame/endFrame (frames from the clip's start) limit when it shows; omit to show for the whole clip. Returns the overlay id.",
    schema: z
      .object({
        clipId: z.string(),
        text: z.string().min(1),
        ...TEXT_STYLE_FIELDS,
        startFrame: z.number().int().min(0).optional(),
        endFrame: z.number().int().positive().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { clipId, ...overlay } = p;
      return { overlay: engine.addTextOverlay(clipId, overlay) };
    },
  },

  set_text_style: {
    description:
      "Restyle EXISTING text overlay(s) on a clip in place. Pass an `overlayId` to target one, or omit to restyle every overlay on the clip. Only the style fields you pass change. Same open vocabulary as add_text.",
    schema: z.object({ clipId: z.string(), overlayId: z.string().optional(), ...TEXT_STYLE_FIELDS }).strict(),
    handler: (engine, p) => {
      const { clipId, overlayId, ...style } = p;
      const overlays = engine.setTextStyle(clipId, overlayId, style);
      return { clipId, count: overlays.length, overlayIds: overlays.map((o) => o.id) };
    },
  },

  set_text_window: {
    description:
      "Move/resize WHEN a text overlay shows, in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a text bar.)",
    schema: z.object({ clipId: z.string(), overlayId: z.string(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ overlay: engine.setTextWindow(p.clipId, p.overlayId, p.startFrame, p.endFrame) }),
  },

  set_graphic_window: {
    description:
      "Move/resize WHEN a motion graphic shows over its clip, in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a graphic bar.)",
    schema: z.object({ clipId: z.string(), graphicId: z.string(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ graphic: engine.setGraphicWindow(p.clipId, p.graphicId, p.startFrame, p.endFrame) }),
  },

  set_caption_cue: {
    description:
      "Move/resize a single caption cue (by its index) in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a caption bar.)",
    schema: z.object({ clipId: z.string(), index: z.number().int().min(0), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ cue: engine.setCaptionCue(p.clipId, p.index, p.startFrame, p.endFrame) }),
  },

  animate_text: {
    description:
      "Animate a text overlay's position or opacity over time — native animated TITLES (fly-ins, slides, fades, pulses) with NO code. property: x | y (canvas fractions, 0=left/top … 1=right/bottom; text centered on the point) | opacity (0..1). REPLACES that property's track (empty list clears it). Each keyframe = {frame, value, ease?} where `frame` is CLIP-LOCAL (0 = clip start) and ease ∈ linear|hold|ease|easeIn|easeOut. Example — a lower-third sliding up while fading in: animate_text(clipId, overlayId, 'y', [{frame:0,value:0.9},{frame:12,value:0.8,ease:'easeOut'}]) and animate_text(clipId, overlayId, 'opacity', [{frame:0,value:0},{frame:12,value:1}]). (For complex coded motion graphics use add_graphic instead.)",
    schema: z
      .object({
        clipId: z.string(),
        overlayId: z.string(),
        property: z.enum(["x", "y", "opacity"]),
        keyframes: z
          .array(z.object({ frame: z.number().int().min(0), value: z.number(), ease: z.enum(EASE_KINDS).optional() }).strict())
          .max(200),
      })
      .strict(),
    handler: (engine, p) => ({ overlay: engine.animateText(p.clipId, p.overlayId, p.property, p.keyframes) }),
  },

  remove_text: {
    description: "Remove a single text overlay from a clip by its overlay id.",
    schema: z.object({ clipId: z.string(), overlayId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeTextOverlay(p.clipId, p.overlayId);
      return { ok: true };
    },
  },

  clear_text: {
    description: "Remove all text overlays from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearTextOverlays(p.clipId);
      return { ok: true };
    },
  },

  generate_captions: {
    description:
      "Transcribe a clip's audio locally with Whisper and attach timed captions burned into the clip. Runs offline; the model auto-downloads on first use. Style with the open style fields or restyle later with set_caption_style. Returns the number of caption cues created.",
    schema: z
      .object({
        clipId: z.string(),
        model: z.enum(WHISPER_MODELS).optional(),
        language: z.string().optional(),
        maxLen: z.number().int().positive().max(120).optional(),
        ...TEXT_STYLE_FIELDS,
      })
      .strict(),
    handler: async (engine, p) => {
      const { clipId, model, language, maxLen, ...style } = p;
      const { clip, cueCount } = await engine.generateCaptions(clipId, {
        model,
        language,
        maxLen,
        style: Object.keys(style).length ? style : undefined,
      });
      return { clipId: clip.id, cueCount, cues: clip.captions?.cues ?? [] };
    },
  },

  set_caption_style: {
    description:
      "Restyle a clip's EXISTING captions without re-transcribing. Open vocabulary — set any of font, fontSize, color, outline, shadow, box, and position or x/y. Only the fields you pass change.",
    schema: z.object({ clipId: z.string(), ...TEXT_STYLE_FIELDS }).strict(),
    handler: (engine, p) => {
      const { clipId, ...style } = p;
      const clip = engine.setCaptionStyle(clipId, style);
      return { clipId: clip.id, style: clip.captions?.style };
    },
  },

  clear_captions: {
    description: "Remove the caption track from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearCaptions(p.clipId);
      return { ok: true };
    },
  },

  get_frame: {
    description:
      "Render a single composited frame of the CURRENT timeline at `atSeconds` (the whole multi-track edit — layering, cuts, color, captions, overlays, transitions) and return it as an image so you can SEE the result and self-correct. Your eyes: after a visual edit, call get_frame to verify before continuing. Defaults to the timeline midpoint.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ path: await engine.renderFrame(p.atSeconds) }),
  },

  inspect_clip: {
    description:
      "Plan an edit on a clip: returns the clip's timeline position + source range, its asset (dimensions, isImage, audio), the canvas, what's ALREADY on the clip (overlays/captions/graphics/effects with their frame windows), AND a few sampled composited frames (images) so you can SEE the footage and choose safe areas / exact placement for a motion graphic or text. Call this before authoring an add_graphic component or placing text, then place it with explicit clip-local startFrame/endFrame.",
    schema: z.object({ clipId: z.string(), frames: z.number().int().min(1).max(5).optional() }).strict(),
    handler: async (engine, p) => engine.inspectClip(p.clipId, p.frames),
  },

  // ---- motion graphics ------------------------------------------------------
  add_graphic: {
    description:
      "Add an animated motion graphic (title card, lower-third, callout, or a whole motion-graphics clip): an AI-authored Remotion React component rendered headlessly to an alpha video. Provide EITHER `code` (a TSX module default-exporting a component using Remotion's useCurrentFrame/useVideoConfig/interpolate/spring/AbsoluteFill) OR `template` (a built-in, e.g. 'title'). PLACEMENT: pass `clipId` to OVERLAY on that clip within a frame window (keep the component background transparent); set standalone=true to insert it as its OWN clip after that one; OR OMIT clipId to add it as a standalone clip (a pure motion-graphics clip — give the component a `background` prop and use durationSeconds). startFrame/endFrame are frames from the clip's start. Rendered at the project canvas size/fps.",
    schema: z
      .object({
        clipId: z.string().optional(),
        code: z.string().min(1).optional(),
        template: z.enum(GRAPHIC_TEMPLATE_NAMES).optional(),
        props: z.record(z.unknown()).optional(),
        startFrame: z.number().int().min(0).optional(),
        endFrame: z.number().int().positive().optional(),
        durationSeconds: z.number().positive().max(600).optional(),
        opacity: z.number().min(0).max(1).optional(),
        standalone: z.boolean().optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      // "code XOR template" is enforced here, not via a top-level .refine():
      // a top-level .refine() makes the schema a ZodEffects with no `.shape`,
      // which makes the MCP layer advertise an empty input schema (clients then
      // strip every argument).
      if (!p.code && !p.template) {
        throw new Error("Provide either `code` (a TSX module) or `template` (a built-in name).");
      }
      const code = p.code ?? GRAPHIC_TEMPLATES[p.template as keyof typeof GRAPHIC_TEMPLATES];
      const r = await engine.addGraphic(p.clipId, {
        code,
        props: p.props,
        startFrame: p.startFrame,
        endFrame: p.endFrame,
        durationSeconds: p.durationSeconds,
        opacity: p.opacity,
        standalone: p.standalone,
      });
      return {
        graphicId: r.graphic?.id,
        clipId: r.clip.id,
        assetId: r.asset.id,
        duration: Number(r.asset.duration.toFixed(3)),
        standalone: !!p.standalone,
      };
    },
  },

  remove_graphic: {
    description: "Remove a single motion-graphic overlay from a clip by its graphic id.",
    schema: z.object({ clipId: z.string(), graphicId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeGraphic(p.clipId, p.graphicId);
      return { ok: true };
    },
  },

  clear_graphics: {
    description: "Remove all motion-graphic overlays from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearGraphics(p.clipId);
      return { ok: true };
    },
  },

  // ---- music & project ------------------------------------------------------
  set_music: {
    description:
      "Set background music for the whole timeline from an imported audio asset. volume defaults to 0.3 (kept under speech); duck=true auto-lowers the music whenever the main audio plays. fadeInFrames/fadeOutFrames in frames. The music loops/trims to the timeline length.",
    schema: z
      .object({
        assetId: z.string(),
        volume: z.number().min(0).max(4).optional(),
        fadeInFrames: z.number().int().min(0).optional(),
        fadeOutFrames: z.number().int().min(0).optional(),
        duck: z.boolean().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      engine.setMusic(p.assetId, { volume: p.volume, fadeInFrames: p.fadeInFrames, fadeOutFrames: p.fadeOutFrames, duck: p.duck });
      return { ok: true };
    },
  },

  remove_music: {
    description: "Remove the background music.",
    schema: empty,
    handler: (engine) => {
      engine.removeMusic();
      return { ok: true };
    },
  },

  set_project_settings: {
    description:
      "Update project settings: name, and/or output canvas width/height/fps. Setting width or height fixes the output aspect ratio (e.g. 1080x1920 for 9:16 vertical). Changing fps rescales all existing frame positions to preserve timing.",
    schema: z
      .object({ name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional() })
      .strict(),
    handler: (engine, p) => {
      engine.setProjectSettings(p);
      return { project: engine.getProject() };
    },
  },

  set_markers: {
    description:
      "Replace the timeline's marker flags (frame positions). Markers are saved with the project and act as snap targets when moving/trimming clips. Pass the full list each time (empty clears them).",
    schema: z.object({ frames: z.array(z.number().int().min(0)).max(2000) }).strict(),
    handler: (engine, p) => {
      engine.setMarkers(p.frames);
      return { markers: engine.getProject().markers ?? [] };
    },
  },

  undo: {
    description: "Undo the last edit.",
    schema: empty,
    handler: (engine) => ({ changed: engine.undo() }),
  },

  redo: {
    description: "Redo the last undone edit.",
    schema: empty,
    handler: (engine) => ({ changed: engine.redo() }),
  },

  render_preview: {
    description: "Render a fast, lower-resolution preview of the entire timeline and return the output file path.",
    schema: empty,
    handler: async (engine) => engine.renderPreview(),
  },

  export_video: {
    description:
      "Render the final video to an absolute output path. Pick a per-platform `preset` (youtube, youtube_hevc, social=Reels/Shorts/TikTok, square, web=webm/vp9, master=near-lossless mov) and/or set fields directly: container (mp4|mov|webm), videoCodec (h264|h265|vp9), quality (CRF; lower=better/bigger), videoBitrate (e.g. '8M', overrides quality), preset/encoder speed, audioCodec (aac|opus), audioBitrate. Explicit fields override the named preset. Resolution & fps come from the canvas (set_project_settings). The output extension also implies the container. Returns {path, duration}.",
    schema: z
      .object({
        outputPath: z.string().min(1),
        preset: z.enum(EXPORT_PRESET_NAMES as [string, ...string[]]).optional(),
        container: z.enum(["mp4", "mov", "webm"]).optional(),
        videoCodec: z.enum(["h264", "h265", "vp9"]).optional(),
        quality: z.number().min(0).max(63).optional(),
        videoBitrate: z.string().optional(),
        encoderPreset: z.string().optional(),
        audioCodec: z.enum(["aac", "opus"]).optional(),
        audioBitrate: z.string().optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const base = p.preset ? EXPORT_PRESETS[p.preset] : {};
      const settings = {
        ...base,
        ...(p.container ? { container: p.container } : {}),
        ...(p.videoCodec ? { videoCodec: p.videoCodec } : {}),
        ...(p.quality !== undefined ? { quality: p.quality } : {}),
        ...(p.videoBitrate ? { videoBitrate: p.videoBitrate } : {}),
        ...(p.encoderPreset ? { preset: p.encoderPreset } : {}),
        ...(p.audioCodec ? { audioCodec: p.audioCodec } : {}),
        ...(p.audioBitrate ? { audioBitrate: p.audioBitrate } : {}),
      };
      return engine.exportVideo(p.outputPath, settings);
    },
  },

  generate_thumbnail: {
    description: "Generate a thumbnail image for an asset at a given time (seconds). Returns the image path.",
    schema: z.object({ assetId: z.string(), atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ path: await engine.generateThumbnail(p.assetId, p.atSeconds) }),
  },

  generate_proxy: {
    description:
      "Transcode a low-res preview PROXY for an asset (snappier scrub/playback of large/4K footage). Auto-runs on import for big sources; call it to force one. The original is never modified and EXPORT always uses full resolution — proxies are preview-only. Returns the updated asset.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: async (engine, p) => ({ asset: await engine.generateProxy(p.assetId) }),
  },

  analyze_silence: {
    description: "Detect silent ranges in an asset's audio (for trimming dead air or finding cut points). Returns [{start, end, duration}] in seconds.",
    schema: z.object({ assetId: z.string(), noiseDb: z.number().optional(), minDur: z.number().positive().optional() }).strict(),
    handler: async (engine, p) => ({ ranges: await engine.analyzeSilence(p.assetId, p.noiseDb, p.minDur) }),
  },

  analyze_scenes: {
    description: "Detect scene-change timestamps in an asset's video (for finding natural cut points). Returns [{time}] in seconds.",
    schema: z.object({ assetId: z.string(), threshold: z.number().min(0).max(1).optional() }).strict(),
    handler: async (engine, p) => ({ cuts: await engine.analyzeScenes(p.assetId, p.threshold) }),
  },

  // ---- Phase 6: media intelligence ------------------------------------------
  create_folder: {
    description: "Create a library folder to organize imported assets. Returns the folder {id, name}.",
    schema: z.object({ name: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ folder: engine.createFolder(p.name) }),
  },

  rename_folder: {
    description: "Rename a library folder.",
    schema: z.object({ folderId: z.string(), name: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ folder: engine.renameFolder(p.folderId, p.name) }),
  },

  delete_folder: {
    description: "Delete a library folder. Its assets are kept (they fall back to no folder).",
    schema: z.object({ folderId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.deleteFolder(p.folderId);
      return { ok: true };
    },
  },

  move_asset_to_folder: {
    description: "Move an asset into a folder, or pass folderId:null to move it out of any folder.",
    schema: z.object({ assetId: z.string(), folderId: z.string().nullable() }).strict(),
    handler: (engine, p) => ({ asset: engine.moveAssetToFolder(p.assetId, p.folderId) }),
  },

  index_transcript: {
    description:
      "Transcribe a WHOLE asset (local Whisper) and cache the spoken-word transcript on it so it becomes searchable. Run once per talking asset; idempotent. Returns the segment count. (Use generate_captions instead when you want burned-in on-screen captions for a placed clip.)",
    schema: z.object({ assetId: z.string(), model: z.enum(WHISPER_MODELS).optional(), language: z.string().optional() }).strict(),
    handler: async (engine, p) => engine.indexTranscript(p.assetId, { model: p.model, language: p.language }),
  },

  search_transcript: {
    description:
      "Search the spoken words across all INDEXED assets (run index_transcript first). Free-text query; exact phrases score highest. Returns ranked hits [{assetId, assetName, start, end, text, score}] with times in seconds — your way to find a quote/topic to cut to.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() }).strict(),
    handler: (engine, p) => ({ hits: engine.searchTranscript(p.query, p.limit) }),
  },

  get_transcript: {
    description:
      "Return the cached spoken-word transcript of an asset ({segments:[{start,end,text}] in seconds, model, language}), or null if not indexed yet (run index_transcript first). Read the real spoken content to decide cuts/quotes — don't guess from filenames.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: (engine, p) => ({ transcript: engine.getTranscript(p.assetId) }),
  },

  locate_in_timeline: {
    description:
      "Find where a spoken phrase lands on the CURRENT timeline. For every placed clip whose asset transcript matches, returns the ABSOLUTE timeline frame range [{clipId, trackIndex, startFrame, endFrame, text}] — feed these straight into ripple_delete_ranges/cut_range to make transcript-driven cuts, or seek to them.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(200).optional() }).strict(),
    handler: (engine, p) => ({ matches: engine.locateInTimeline(p.query, p.limit) }),
  },

  index_visual: {
    description:
      "Build a perceptual visual fingerprint for an asset (a few sampled keyframes) so it can be matched by appearance. Auto-run by search_visual, but you can pre-index. If a CLIP model is installed (AIVE_CLIP_VISION) it also stores semantic embeddings. Returns {sampleCount, semantic}.",
    schema: z.object({ assetId: z.string(), count: z.number().int().min(1).max(12).optional() }).strict(),
    handler: async (engine, p) => engine.indexVisual(p.assetId, p.count),
  },

  search_visual: {
    description:
      "Find shots by appearance or MEANING. Two modes: (1) pass a free-text `query` (e.g. 'wide shot of a sunset over water') for SEMANTIC text→image search via the local CLIP model (downloaded once on first use; falls back with a clear error if it can't be obtained). (2) pass a reference frame — a clip (clipId + clip-local atSeconds) OR an asset (assetId + atSeconds) — to find shots that LOOK like it (perceptual, plus CLIP image↔image when available). Returns {semantic, mode, hits:[{assetId, name, score, atSeconds}]} ranked best-first; atSeconds is the best-matching moment. Auto-indexes candidates.",
    schema: z
      .object({
        query: z.string().optional(),
        clipId: z.string().optional(),
        assetId: z.string().optional(),
        atSeconds: z.number().min(0).optional(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      if (!p.query && !p.clipId && !p.assetId) throw new Error("Provide a text `query` or a reference clipId/assetId.");
      return engine.searchVisual({ query: p.query, clipId: p.clipId, assetId: p.assetId, atSeconds: p.atSeconds }, p.limit);
    },
  },

  sync_audio: {
    description:
      "Align a clip to a reference clip by SOUND (cross-correlates their audio — great for multi-cam/second-take sync). Measures the time offset and, unless apply:false, MOVES the clip on the timeline so its audio lines up with the reference. Returns {offsetSeconds, offsetFrames, confidence (−1..1), applied}.",
    schema: z.object({ clipId: z.string(), referenceClipId: z.string(), apply: z.boolean().optional() }).strict(),
    handler: async (engine, p) => engine.syncAudio(p.clipId, p.referenceClipId, p.apply ?? true),
  },

  save_project: {
    description: "Save the project to a .aive JSON file at the given absolute path. This is 'Save As' — it also becomes the project's current file, so later `save` calls reuse this path.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      await engine.save(p.path);
      return { ok: true, path: p.path };
    },
  },

  save: {
    description: "Save the project to its CURRENT file (the path it was last saved to or opened from) — the plain 'Save'. Fails if the project has never been saved; use save_project with a path for that first (Save As).",
    schema: empty,
    handler: async (engine) => {
      const path = engine.getCurrentPath();
      if (!path) {
        throw new Error("This project has no file yet. Use save_project with an absolute path (Save As) before calling save.");
      }
      await engine.save(path);
      return { ok: true, path };
    },
  },

  load_project: {
    description: "Load a project from a .aive JSON file at the given absolute path (old single-track projects are migrated to the multi-track frame model). Unsaved edits in the currently-open project are auto-saved first, so nothing is lost; the returned `autosaved` says whether/where that happened.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      const autosaved = await engine.autoSaveIfDirty();
      const project = await engine.load(p.path);
      return { project, autosaved };
    },
  },

  new_project: {
    description: "Discard the current project and start a fresh, empty one. Unsaved edits in the current project are auto-saved first (to its file, or a recovery file if it was never saved), so nothing is lost; the returned `autosaved` says whether/where that happened.",
    schema: empty,
    handler: async (engine) => {
      const autosaved = await engine.autoSaveIfDirty();
      engine.reset();
      return { project: engine.getProject(), autosaved };
    },
  },
} satisfies Record<string, RpcMethod>;

export type MethodName = keyof typeof methods;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_method" | "invalid_params" | "handler_error",
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Validate and execute an RPC method against the engine. */
export async function dispatch(engine: EditorEngine, method: string, params: unknown): Promise<unknown> {
  const entry = (methods as Record<string, RpcMethod>)[method];
  if (!entry) {
    throw new RpcError(`Unknown method "${method}"`, "unknown_method");
  }
  const parsed = entry.schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcError(`Invalid params for "${method}": ${parsed.error.message}`, "invalid_params");
  }
  return entry.handler(engine, parsed.data);
}
