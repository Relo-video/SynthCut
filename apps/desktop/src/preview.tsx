// Real-time preview compositor. Instead of one <video> playing the base track,
// this draws EVERY video track per frame onto a <canvas> in true z-order (higher
// Track.index on top), with opacity/fades, crop and a color proxy — and mixes
// audio from all tracks plus the music bed. It's the "modern feel": live
// layering while you scrub, no FFmpeg render needed. The exact, frame-accurate
// composite still lives behind "Render exact" / Export (FFmpeg is ground truth).
//
// How it works: composite.ts is a PURE (model, playhead) -> draw plan; a
// MediaPool of hidden <video> decoders supplies the pixels/audio; this component
// owns the master clock (RAF) and rasterizes the plan with Canvas2D. Text and
// captions stay DOM overlays on top of the canvas. Motion graphics are
// export-only in preview (unchanged from before).

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";
import type { CSSProperties } from "react";
import type { CoreApi } from "./api";
import type { MediaAsset, MusicSettings, Project, TextStyle } from "./types";
import {
  segmentAt, totalDuration,
  type PlayerHandle, type PlaybackStore, type Segment,
} from "./playback";
import { activeLayersAt, timelineDurationSec, type ActiveClip } from "./composite";
import { MediaPool } from "./mediapool";
import { Film, Play, Waveform } from "./icons";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const POS_STYLE: Record<string, CSSProperties> = {
  top: { top: "7%", left: 0, right: 0, justifyContent: "center" },
  center: { top: "50%", left: 0, right: 0, justifyContent: "center", transform: "translateY(-50%)" },
  bottom: { bottom: "9%", left: 0, right: 0, justifyContent: "center" },
  topleft: { top: "7%", left: "6%", justifyContent: "flex-start" },
  topright: { top: "7%", right: "6%", justifyContent: "flex-end" },
  bottomleft: { bottom: "9%", left: "6%", justifyContent: "flex-start" },
  bottomright: { bottom: "9%", right: "6%", justifyContent: "flex-end" },
};

// FFmpeg colors (#RRGGBB[AA], a name, or name@alpha) → a CSS-safe color. The
// preview approximates `name@alpha` by dropping the alpha.
function cssColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
  const at = c.indexOf("@");
  return at >= 0 ? c.slice(0, at) || fallback : c;
}

// Render a styled text line over the canvas — the live proxy for the FFmpeg
// drawtext burn-in. Honors the full open style (font, color, outline, shadow,
// box, keyword position or free x/y).
function textBlock(
  key: string,
  text: string,
  style: TextStyle | undefined,
  defaultBox: boolean,
  canvasH: number,
  anim?: { x?: number; y?: number; opacity?: number },
) {
  const s = style ?? {};
  // Animated x/y (canvas fractions) override the static placement this frame.
  const ax = anim?.x ?? s.x;
  const ay = anim?.y ?? s.y;
  const pos: CSSProperties =
    ax !== undefined || ay !== undefined
      ? { left: `${(ax ?? 0.5) * 100}%`, top: `${(ay ?? 0.5) * 100}%`, transform: "translate(-50%, -50%)", justifyContent: "center" }
      : POS_STYLE[s.position ?? "bottom"] ?? POS_STYLE.bottom;

  const box = s.box ?? defaultBox;
  const shadows = ["0 2px 8px rgba(0,0,0,0.55)"];
  if ((s.shadowX ?? 0) !== 0 || (s.shadowY ?? 0) !== 0) {
    shadows.unshift(`${s.shadowX ?? 2}px ${s.shadowY ?? 2}px 2px ${cssColor(s.shadowColor, "#000")}`);
  }
  const container: CSSProperties = {
    ...pos,
    ...(anim?.opacity !== undefined ? { opacity: Math.min(1, Math.max(0, anim.opacity)) } : {}),
    color: cssColor(s.color, "#fff"),
    fontFamily: s.font ? `"${s.font}", inherit` : undefined,
    // Size text as the SAME fraction of the displayed canvas height that the
    // FFmpeg export uses (fontSize px ÷ project canvas height). `cqh` resolves
    // against the .pv-overlays container (= the stage/canvas height), so the
    // preview matches the export instead of using window-relative `vh` (which
    // made text balloon and wrap on small preview panels).
    fontSize: `clamp(8px, ${(((s.fontSize ?? 42) / canvasH) * 100).toFixed(3)}cqh, 400px)`,
    textShadow: shadows.join(", "),
    ...(s.outlineWidth && s.outlineWidth > 0
      ? { WebkitTextStroke: `${Math.min(s.outlineWidth, 6)}px ${cssColor(s.outlineColor, "#000")}` }
      : {}),
  };
  return (
    <div key={key} className="pv-text" style={container}>
      <span
        className={box ? "pv-text-box" : ""}
        style={box ? { background: cssColor(s.boxColor, "rgba(0,0,0,0.62)") } : undefined}
      >
        {text}
      </span>
    </div>
  );
}

/** Compositor drawing-buffer size: project aspect, long edge capped for speed. */
function bufferSize(project: Project | null, maxLongEdge = 1280): { w: number; h: number } {
  if (!project) return { w: 1280, h: 720 };
  const longEdge = Math.max(project.width, project.height);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  return { w: Math.max(2, Math.round(project.width * scale)), h: Math.max(2, Math.round(project.height * scale)) };
}

/**
 * Draw one video layer: crop → letterbox-contain fit → 2D transform (scale,
 * rotate, flip, translate about the canvas centre) → color filter → alpha. The
 * transform mirrors the FFmpeg geq bake so preview and export agree.
 */
function drawLayer(ctx: CanvasRenderingContext2D, el: HTMLVideoElement | HTMLImageElement, d: NonNullable<ActiveClip["draw"]>, W: number, H: number) {
  // Intrinsic source dimensions: <video> exposes videoWidth, <img> naturalWidth.
  const iw = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth;
  const ih = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight;
  const sx = d.crop?.x ?? 0;
  const sy = d.crop?.y ?? 0;
  const sw = d.crop?.width ?? iw;
  const sh = d.crop?.height ?? ih;
  if (sw <= 0 || sh <= 0) return;
  const fit = Math.min(W / sw, H / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const t = d.transform;

  ctx.save();
  ctx.filter = d.colorFilter && d.colorFilter !== "none" ? d.colorFilter : "none";
  ctx.globalAlpha = clamp01(d.opacity);
  ctx.translate(W / 2 + t.x * W, H / 2 + t.y * H);
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale((t.flipH ? -1 : 1) * t.scale, (t.flipV ? -1 : 1) * t.scale);
  try {
    ctx.drawImage(el, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch {
    /* element not yet decodable this frame — skip, next frame paints it */
  }
  ctx.restore();
}

/** DOM-facing snapshot of the current frame (only changes when overlays/badge change). */
interface FrameInfo {
  textClips: { clipId: string; overlays: ActiveClip["overlays"]; caption?: ActiveClip["caption"] }[];
  topName?: string;
  audioOnly: boolean;
  graded: boolean;
  drawCount: number;
}

const EMPTY_FRAME: FrameInfo = { textClips: [], audioOnly: false, graded: false, drawCount: 0 };

/** Stable signature so we only re-render the React overlay subtree when it changes. */
function frameSig(f: FrameInfo): string {
  return JSON.stringify(f);
}

interface Props {
  segments: Segment[];
  project: Project | null;
  assetById: Map<string, MediaAsset>;
  music?: MusicSettings;
  musicAsset?: MediaAsset;
  api: CoreApi;
  store: PlaybackStore;
  onSelectClip: (clipId: string) => void;
}

export const PreviewPlayer = forwardRef<PlayerHandle, Props>(function PreviewPlayer(
  { segments, project, assetById, music, musicAsset, api, store, onSelectClip },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const poolRef = useRef<MediaPool | null>(null);

  const rafRef = useRef(0);
  const redrawRef = useRef(0);
  const lastNow = useRef(0);
  const playingRef = useRef(false);
  const phRef = useRef(0);
  const drawFnRef = useRef<() => void>(() => {});
  // Still images can't go through the <video> pool — cache one <img> per path and
  // repaint once it loads (so an image clip shows in the preview, not just export).
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>());
  // Offscreen buffer for ADJUSTMENT layers: the composite below is drawn here,
  // then painted back through ctx.filter (mirrors the FFmpeg split→filter→overlay).
  const adjCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sigRef = useRef("");

  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<FrameInfo>(EMPTY_FRAME);

  const fps = project?.fps ?? 30;
  const aspect = project ? `${project.width} / ${project.height}` : "16 / 9";
  const canvasH = project?.height ?? 1080;
  const buf = useMemo(() => bufferSize(project), [project]);

  const projectRef = useRef(project);
  projectRef.current = project;
  const assetsRef = useRef(assetById);
  assetsRef.current = assetById;
  const musicRefData = useRef<{ music?: MusicSettings; asset?: MediaAsset }>({ music, asset: musicAsset });
  musicRefData.current = { music, asset: musicAsset };

  // Master end stop: the furthest extent across ALL tracks (not just the base).
  const total = useMemo(() => Math.max(timelineDurationSec(project), totalDuration(segments)), [project, segments]);
  const totalRef = useRef(total);
  totalRef.current = total;

  const hasClips = segments.length > 0;

  const writePh = useCallback(
    (v: number) => {
      phRef.current = v;
      store.set({ playhead: v });
    },
    [store],
  );

  useEffect(() => {
    store.set({ duration: total });
  }, [total, store]);

  // ----- the per-frame compositor ------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const pool = poolRef.current;
    if (!canvas || !pool) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const plan = activeLayersAt(projectRef.current, assetsRef.current, phRef.current);
    pool.beginFrame();
    // Draw a clip's active motion graphics full-frame over it (alpha .webm proxy,
    // drawImage preserves transparency) so graphics preview live, in clip z-order.
    const paintGraphics = (gs: ActiveClip["graphics"]) => {
      for (const g of gs) {
        const gel = pool.acquire(`gfx:${g.key}`, g.path);
        pool.sync(gel, { srcTime: g.srcTime, playing: playingRef.current, rate: 1, volume: 0, muted: true });
        if (gel.readyState >= 2 && gel.videoWidth > 0) {
          ctx.save();
          ctx.globalAlpha = clamp01(g.opacity);
          try { ctx.drawImage(gel, 0, 0, W, H); } catch { /* not decodable this frame */ }
          ctx.restore();
        }
      }
    };
    // ADJUSTMENT layer: repaint the composite drawn SO FAR through its color
    // filter (lower layers only — higher tracks draw after, unaffected).
    const applyAdjust = (filter: string) => {
      if (!filter || filter === "none") return;
      let off = adjCanvasRef.current;
      if (!off) adjCanvasRef.current = off = document.createElement("canvas");
      if (off.width !== W) off.width = W;
      if (off.height !== H) off.height = H;
      const octx = off.getContext("2d");
      if (!octx) return;
      octx.clearRect(0, 0, W, H);
      octx.drawImage(canvas, 0, 0);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.filter = filter;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    };
    for (const c of plan.clips) {
      if (c.adjust) {
        applyAdjust(c.adjust.colorFilter);
        continue;
      }
      if (!c.path) continue;
      if (c.isImage) {
        // Still image: draw from the <img> cache (no audio, no decoder pool).
        if (!c.draw) continue;
        const cache = imgCacheRef.current;
        let img = cache.get(c.path);
        if (!img) {
          img = new Image();
          img.onload = () => { if (!playingRef.current) requestAnimationFrame(() => drawFnRef.current()); };
          img.src = api.fileUrl(c.path);
          cache.set(c.path, img);
        }
        if (img.complete && img.naturalWidth > 0) drawLayer(ctx, img, c.draw, W, H);
        paintGraphics(c.graphics);
        continue;
      }
      const el = pool.acquire(c.clipId, c.path);
      pool.sync(el, {
        srcTime: c.srcTime,
        playing: playingRef.current,
        rate: c.rate,
        volume: c.audio?.volume ?? 0,
        muted: !c.audio,
      });
      if (c.draw && el.readyState >= 2 && el.videoWidth > 0) drawLayer(ctx, el, c.draw, W, H);
      paintGraphics(c.graphics);
    }
    pool.endFrame();

    // ----- DOM overlay / badge snapshot (only setState when it changes) ------
    const drawClips = plan.clips.filter((c) => c.draw);
    const top = drawClips[drawClips.length - 1];
    const audible = plan.clips.find((c) => c.audio);
    const info: FrameInfo = {
      textClips: drawClips
        .filter((c) => c.overlays.length > 0 || c.caption)
        .map((c) => ({ clipId: c.clipId, overlays: c.overlays, caption: c.caption })),
      topName: top?.assetName ?? audible?.assetName,
      audioOnly: drawClips.length === 0 && !!audible,
      graded: !!top && top.draw!.colorFilter !== "none",
      drawCount: drawClips.length,
    };
    const sig = frameSig(info);
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      setFrame(info);
    }
  }, []);
  drawFnRef.current = draw;

  // A one-shot redraw used while paused (scrubbing / a decoder finishing a seek).
  const scheduleRedraw = useCallback(() => {
    if (playingRef.current) return; // the RAF loop already redraws continuously
    if (redrawRef.current) return;
    redrawRef.current = requestAnimationFrame(() => {
      redrawRef.current = 0;
      drawFnRef.current();
    });
  }, []);

  // Build the decoder pool once (after the host div mounts).
  useEffect(() => {
    if (!hostRef.current) return;
    const pool = new MediaPool(hostRef.current, (p) => api.fileUrl(p), () => scheduleRedraw());
    poolRef.current = pool;
    return () => {
      pool.destroy();
      poolRef.current = null;
    };
  }, [api, scheduleRedraw]);

  // ----- music bed ----------------------------------------------------------
  const syncMusic = useCallback((play: boolean) => {
    const a = musicRef.current;
    const { music: m, asset } = musicRefData.current;
    if (!a) return;
    if (!m || !asset) {
      a.pause();
      return;
    }
    a.loop = true;
    a.volume = clamp01(m.volume);
    const dur = asset.duration > 0 ? asset.duration : 0;
    const want = dur > 0 ? phRef.current % dur : phRef.current;
    if (Math.abs(a.currentTime - want) > 0.25) {
      try { a.currentTime = want; } catch { /* not ready yet */ }
    }
    if (play) void a.play().catch(() => {});
    else a.pause();
  }, []);

  // ----- transport ----------------------------------------------------------
  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  const tick = useCallback(
    (now: number) => {
      const dt = lastNow.current ? (now - lastNow.current) / 1000 : 0;
      lastNow.current = now;
      let ph = phRef.current + dt; // timeline runs at 1× wall-time; clip speed only samples the source
      const tot = totalRef.current;
      if (ph >= tot) {
        ph = tot;
        phRef.current = ph;
        store.set({ playhead: ph });
        drawFnRef.current();
        // Reached the end — stop.
        playingRef.current = false;
        setPlaying(false);
        store.set({ playing: false });
        poolRef.current?.pauseAll();
        syncMusic(false);
        stopRaf();
        return;
      }
      phRef.current = ph;
      store.set({ playhead: ph });
      drawFnRef.current();
      rafRef.current = requestAnimationFrame(tick);
    },
    [store, syncMusic],
  );

  const doPlay = useCallback(() => {
    if (!hasClips) return;
    if (phRef.current >= totalRef.current - 0.02) writePh(0); // restart if parked at the end
    playingRef.current = true;
    setPlaying(true);
    store.set({ playing: true });
    lastNow.current = 0;
    syncMusic(true);
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [hasClips, writePh, store, tick, syncMusic]);

  const doPause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    store.set({ playing: false });
    poolRef.current?.pauseAll();
    syncMusic(false);
    stopRaf();
  }, [store, syncMusic]);

  const doSeek = useCallback(
    (time: number) => {
      const clamped = Math.min(totalRef.current, Math.max(0, time));
      writePh(clamped);
      if (playingRef.current) syncMusic(true);
      else syncMusic(false);
      drawFnRef.current();
      scheduleRedraw();
    },
    [writePh, syncMusic, scheduleRedraw],
  );

  useImperativeHandle(
    ref,
    (): PlayerHandle => ({
      play: doPlay,
      pause: doPause,
      toggle: () => (playingRef.current ? doPause() : doPlay()),
      seek: doSeek,
      step: (frames) => doSeek(phRef.current + frames / fps),
      jumpClip: (dir) => {
        const segs = segments;
        if (!segs.length) return;
        const cur = segmentAt(segs, phRef.current);
        if (!cur) return;
        if (dir < 0) {
          const target = phRef.current - cur.start > 0.4 ? cur : segs[Math.max(0, cur.index - 1)];
          doSeek(target.start);
        } else {
          const next = segs[Math.min(segs.length - 1, cur.index + 1)];
          doSeek(cur.index === segs.length - 1 ? totalRef.current : next.start);
        }
      },
    }),
    [doPlay, doPause, doSeek, fps, segments],
  );

  // The edit changed under us (AI edit, trim, reorder…). Clamp the playhead to
  // the new duration and repaint, preserving play state.
  useEffect(() => {
    const clamped = Math.min(total, Math.max(0, phRef.current));
    writePh(clamped);
    if (playingRef.current) syncMusic(true);
    drawFnRef.current();
    scheduleRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, total]);

  // Repaint once when the drawing buffer (project resolution) changes.
  useEffect(() => {
    drawFnRef.current();
    scheduleRedraw();
  }, [buf.w, buf.h, scheduleRedraw]);

  useEffect(
    () => () => {
      stopRaf();
      if (redrawRef.current) cancelAnimationFrame(redrawRef.current);
    },
    [],
  );

  return (
    <div className="pv">
      <div className="pv-stage" style={{ aspectRatio: aspect } as CSSProperties}>
        <canvas
          ref={canvasRef}
          className="pv-video"
          width={buf.w}
          height={buf.h}
          onClick={() => {
            if (hasClips) (playingRef.current ? doPause() : doPlay());
            const seg = segmentAt(segments, phRef.current);
            if (seg) onSelectClip(seg.clip.id);
          }}
        />

        {/* Hidden decoder pool host (off-screen, kept in the DOM so it decodes). */}
        <div ref={hostRef} className="pv-pool" aria-hidden="true" />

        {/* Looping background-music bed. */}
        <audio
          ref={musicRef}
          src={musicAsset ? api.fileUrl(musicAsset.path) : undefined}
          preload="auto"
        />

        {!hasClips && (
          <div className="pv-empty">
            <span className="pv-empty-icon"><Play size={26} /></span>
            <span className="pv-empty-title">Nothing on the timeline yet</span>
            <span className="pv-empty-sub">
              Add a clip from the library, or ask your AI client to build the edit —
              it plays here instantly, no render needed.
            </span>
          </div>
        )}

        {hasClips && frame.audioOnly && (
          <div className="pv-audioonly">
            <Waveform size={26} />
            <span>{frame.topName ?? "Audio"}</span>
          </div>
        )}

        {/* Live burned-in proxies (text + captions) for every visible layer. */}
        {hasClips && frame.textClips.length > 0 && (
          <div className="pv-overlays" aria-hidden="true">
            {frame.textClips.map((c) => (
              <div key={c.clipId} style={{ position: "absolute", inset: 0 }}>
                {c.overlays.map((o) => textBlock(`${c.clipId}-${o.id}`, o.text, o, o.box ?? false, canvasH, o.anim))}
                {c.caption && textBlock(`${c.clipId}-cue`, c.caption.text, { color: "#ffe14d", ...c.caption.style }, true, canvasH)}
              </div>
            ))}
          </div>
        )}
      </div>

      {hasClips && frame.drawCount > 0 && (
        <div className="pv-badge">
          <Film size={12} />
          <span className="pv-badge-name">{frame.topName ?? "Clip"}</span>
          <span className="pv-badge-idx">
            {frame.drawCount} layer{frame.drawCount === 1 ? "" : "s"}
          </span>
          {!playing && frame.graded && <span className="pv-badge-tag">graded</span>}
        </div>
      )}
    </div>
  );
});
