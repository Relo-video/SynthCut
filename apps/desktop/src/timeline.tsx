// Modern multi-track timeline. A stacked row of video + audio tracks (video
// higher index on top, matching the compositor's z-order), each with a header
// (name, mute/hide/lock, audio volume + level meter) and a lane of absolutely
// positioned clip blocks. Clips drag to move (in time and across same-kind
// tracks) and drag their edges to trim, with SNAPPING to the playhead, clip
// edges, markers and zero. A ruler carries time ticks + markers; a draggable
// playhead, zoom, and the preview stay in lockstep (everything laid out in
// pixels/second derived from the project's frame-based model).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { Marker, MediaAsset, MusicSettings, Project, Track } from "./types";
import { clipDurationFrames } from "./types";
import {
  buildSegments, fmtTime, tickInterval, usePlaybackValue,
  type PlaybackStore, type Segment,
} from "./playback";
import { timelineDurationSec } from "./composite";
import { usePeaks, peakRange } from "./waveform";
import {
  Captions, Eye, EyeOff, Lock, Music, Plus, Scissors, Sparkles, Type,
  Volume, VolumeX, Waveform, X, ZoomIn, ZoomOut,
} from "./icons";

const MIN_PPS = 8;
const MAX_PPS = 480;
const GUTTER_W = 138;
const RULER_H = 26;
const SNAP_PX = 7;
const VIDEO_H = 60;
const AUDIO_H = 48;
/** Height of a dedicated element lane (text / graphics / captions) below the tracks. */
const ELEM_LANE_H = 22;
const MUSIC_H = 30;

function trackHeight(t: Track): number {
  return t.height ?? (t.kind === "video" ? VIDEO_H : AUDIO_H);
}


/** Rows top-to-bottom: video tracks (highest index first), then audio tracks. */
function orderedTracks(project: Project | null): Track[] {
  if (!project) return [];
  const video = project.tracks.filter((t) => t.kind === "video").sort((a, b) => b.index - a.index);
  const audio = project.tracks.filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index);
  return [...video, ...audio];
}

interface Props {
  project: Project | null;
  assetById: Map<string, MediaAsset>;
  thumbs: Record<string, string>;
  store: PlaybackStore;
  selectedClip: string | null;
  justUpdated: boolean;
  connected: boolean;
  music?: MusicSettings;
  musicAsset?: MediaAsset;
  onSelectClip: (id: string) => void;
  onSeek: (time: number) => void;
  onSplit: (clipId: string, atLocalFrame: number) => void;
  onMoveClip: (clipId: string, startFrame: number, trackIndex: number) => void;
  onTrimClip: (clipId: string, sourceInFrame: number | undefined, sourceOutFrame: number | undefined) => void;
  onRemove: (clipId: string) => void;
  onRippleDelete: (trackIndex: number, startFrame: number, endFrame: number) => void;
  onSetTrack: (trackIndex: number, patch: Record<string, unknown>) => void;
  onAddTrack: (kind: "video" | "audio") => void;
  onRemoveTrack: (trackIndex: number) => void;
  /** Persist the timeline markers — saved with the project. */
  onSetMarkers: (markers: Marker[]) => void;
  /** Move/resize a text overlay, motion graphic, or caption cue (clip-local frames). */
  onSetElementWindow: (
    kind: "text" | "graphic" | "caption",
    clipId: string,
    ref: string | number,
    startFrame: number,
    endFrame: number,
  ) => void;
}

/** One element (text overlay / motion graphic / caption cue) on its lane, with
 * its ABSOLUTE timeline range plus the owning clip's bounds (to clamp drags). */
type LaneBar = {
  clipId: string; ref: string | number; label: string;
  absS: number; absE: number; clipStart: number; clipDur: number; full?: string;
};

/** A drag in progress: moving a clip, or trimming one of its edges. */
type Drag =
  | { kind: "move"; clipId: string; track: Track; seg: Segment; grabFrame: number; startX: number; ghostStart: number; ghostTrack: number }
  | { kind: "trim"; clipId: string; track: Track; seg: Segment; edge: "l" | "r"; startX: number; newStart: number; newIn: number; newOut: number };

export function Timeline(props: Props) {
  const {
    project, assetById, thumbs, store, selectedClip, justUpdated, connected,
    music, musicAsset, onSelectClip, onSeek, onSplit, onMoveClip, onTrimClip,
    onRemove, onRippleDelete, onSetTrack, onAddTrack, onRemoveTrack, onSetElementWindow,
    onSetMarkers,
  } = props;

  const fps = project?.fps ?? 30;
  const rows = useMemo(() => orderedTracks(project), [project]);
  const laneSegs = useMemo(() => {
    const m = new Map<number, Segment[]>();
    for (const t of rows) {
      const sorted = [...t.clips].sort((a, b) => a.startFrame - b.startFrame);
      m.set(t.index, buildSegments(sorted, assetById, fps));
    }
    return m;
  }, [rows, assetById, fps]);

  // Text / motion-graphic / caption elements collected across all video clips,
  // each with its ABSOLUTE timeline range, shown on their own lanes below the
  // tracks (not over the footage). Dragging converts back to clip-local frames.
  const elLanes = useMemo(() => {
    const text: LaneBar[] = [], gfx: LaneBar[] = [], cap: LaneBar[] = [];
    for (const t of rows) {
      if (t.kind !== "video") continue;
      for (const clip of t.clips) {
        const dur = clipDurationFrames(clip);
        const cs = clip.startFrame;
        for (const o of clip.overlays ?? [])
          text.push({ clipId: clip.id, ref: o.id, label: o.text, absS: cs + (o.startFrame ?? 0), absE: cs + (o.endFrame ?? dur), clipStart: cs, clipDur: dur });
        for (const g of clip.graphics ?? [])
          gfx.push({ clipId: clip.id, ref: g.id, label: String(g.props?.title ?? "graphic"), absS: cs + (g.startFrame ?? 0), absE: cs + (g.endFrame ?? dur), clipStart: cs, clipDur: dur });
        (clip.captions?.cues ?? []).forEach((c, i) =>
          cap.push({ clipId: clip.id, ref: i, label: i === 0 ? "CC" : "", absS: cs + c.startFrame, absE: cs + c.endFrame, clipStart: cs, clipDur: dur, full: c.text }));
      }
    }
    return { text, gfx, cap };
  }, [rows]);

  const total = useMemo(() => Math.max(timelineDurationSec(project), 1), [project]);
  const clipCount = rows.reduce((n, t) => n + t.clips.length, 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const laneEls = useRef(new Map<number, HTMLElement>());
  const [viewW, setViewW] = useState(800);
  const [pps, setPps] = useState(56);
  const pxPerFrame = pps / fps;
  const scrubbing = useRef(false);
  // Latest pps for the native (non-passive) wheel-zoom listener below.
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  // Markers are persisted on the project (saved in the .aive, shared with the AI).
  const markers = useMemo(() => project?.markers ?? [], [project]);
  const addMarkerAt = useCallback(
    (frame: number) => { if (!markers.some((m) => m.frame === frame)) onSetMarkers([...markers, { frame }]); },
    [markers, onSetMarkers],
  );
  const removeMarkerAt = useCallback(
    (frame: number) => onSetMarkers(markers.filter((m) => m.frame !== frame)),
    [markers, onSetMarkers],
  );
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // Panel height resize (drag the top edge).
  const [height, setHeight] = useState(220);
  const resizing = useRef<{ y: number; h: number } | null>(null);
  const onResizeDown = (e: ReactPointerEvent) => {
    resizing.current = { y: e.clientY, h: height };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent) => {
    if (!resizing.current) return;
    const dy = resizing.current.y - e.clientY;
    const max = Math.max(260, window.innerHeight * 0.72);
    setHeight(Math.max(150, Math.min(max, resizing.current.h + dy)));
  };
  const onResizeUp = (e: ReactPointerEvent) => {
    resizing.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setViewW(e.contentRect.width); });
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (total <= 0) return;
    setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, (viewW - GUTTER_W - 48) / total)));
  }, [total, viewW]);

  // Cursor-anchored horizontal scaling: Ctrl/⌘ + wheel scales pixels-per-second
  // while keeping the moment under the pointer pinned. Registered natively with
  // { passive: false } so preventDefault actually suppresses the page zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Ctrl/⌘ + wheel → cursor-anchored horizontal ZOOM of the timeline only.
      // (The window-level guard in App.tsx also blocks page zoom, so the rest of
      // the app — preview, panels — never scales.)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cur = ppsRef.current;
        const secAtCursor = (el.scrollLeft + cursorX) / cur;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = Math.max(MIN_PPS, Math.min(MAX_PPS, cur * factor));
        if (next === cur) return;
        setPps(next);
        requestAnimationFrame(() => { el.scrollLeft = secAtCursor * next - cursorX; });
        return;
      }
      const overflowsX = el.scrollWidth > el.clientWidth + 1;
      // Horizontal intent (trackpad deltaX or Shift+wheel) → always pan the
      // timeline and CONSUME the event, so a sideways swipe can never escape to
      // scroll the app shell or trigger back/forward navigation.
      if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) {
        if (overflowsX) el.scrollLeft += e.deltaX || e.deltaY;
        e.preventDefault();
        return;
      }
      // Vertical wheel (the mouse-wheel case): when the timeline is wider than
      // the viewport, map it to horizontal panning so a plain wheel scrolls the
      // zoomed-in timeline. Otherwise leave it alone so the tracks (.tl-body) can
      // scroll vertically.
      if (overflowsX) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const contentW = Math.max(viewW - GUTTER_W, total * pps + 64);

  const frameFromClientX = useCallback(
    (clientX: number) => {
      const el = contentRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.round(((clientX - rect.left) / pps) * fps));
    },
    [pps, fps],
  );

  // ----- scrub (ruler / empty lane) -----------------------------------------
  const seekToClientX = useCallback((clientX: number) => onSeek(frameFromClientX(clientX) / fps), [frameFromClientX, fps, onSeek]);
  const onScrubDown = (e: ReactPointerEvent) => {
    if (total <= 0) return;
    scrubbing.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX);
  };
  const onScrubMove = (e: ReactPointerEvent) => { if (scrubbing.current) seekToClientX(e.clientX); };
  const onScrubUp = (e: ReactPointerEvent) => {
    scrubbing.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  // ----- snapping ------------------------------------------------------------
  const snapTargets = useCallback(
    (excludeClipId: string): number[] => {
      const out: number[] = [0, Math.round(store.get().playhead * fps), ...markers.map((m) => m.frame)];
      for (const t of rows) {
        for (const c of t.clips) {
          if (c.id === excludeClipId) continue;
          out.push(c.startFrame, c.startFrame + clipDurationFrames(c));
        }
      }
      return out;
    },
    [rows, markers, store, fps],
  );
  const snap = useCallback(
    (frame: number, targets: number[]): number => {
      const thresh = SNAP_PX / Math.max(1e-6, pxPerFrame);
      let best = frame;
      let bestD = thresh;
      for (const t of targets) {
        const d = Math.abs(frame - t);
        if (d <= bestD) { bestD = d; best = t; }
      }
      return Math.max(0, best);
    },
    [pxPerFrame],
  );

  // ----- clip drag (move + trim) via window listeners ------------------------
  const trackAtClientY = useCallback(
    (clientY: number, kind: "video" | "audio"): number | null => {
      for (const [idx, el] of laneEls.current) {
        const t = rows.find((r) => r.index === idx);
        if (!t || t.kind !== kind || t.locked) continue;
        const r = el.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) return idx;
      }
      return null;
    },
    [rows],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "move") {
        const targets = snapTargets(d.clipId);
        const cur = frameFromClientX(e.clientX);
        const rawStart = Math.max(0, cur - d.grabFrame);
        const dur = clipDurationFrames(d.seg.clip);
        // Snap either the clip's head or tail to a target.
        const snappedHead = snap(rawStart, targets);
        const snappedTail = snap(rawStart + dur, targets) - dur;
        const ghostStart = Math.abs(snappedHead - rawStart) <= Math.abs(snappedTail - rawStart) ? snappedHead : Math.max(0, snappedTail);
        const ghostTrack = trackAtClientY(e.clientY, d.track.kind) ?? d.ghostTrack;
        setDrag({ ...d, ghostStart, ghostTrack });
      } else {
        const targets = snapTargets(d.clipId);
        const f = snap(frameFromClientX(e.clientX), targets);
        const speed = d.seg.speed;
        const assetFrames = d.seg.asset ? Math.round(d.seg.asset.duration * fps) : Number.MAX_SAFE_INTEGER;
        if (d.edge === "l") {
          const maxStart = d.seg.clip.startFrame + clipDurationFrames(d.seg.clip) - 1;
          const newStart = Math.min(maxStart, Math.max(0, f));
          const deltaFrames = newStart - d.seg.clip.startFrame;
          const newIn = Math.min(d.seg.clip.sourceOutFrame - 1, Math.max(0, Math.round(d.seg.clip.sourceInFrame + deltaFrames * speed)));
          setDrag({ ...d, newStart, newIn, newOut: d.seg.clip.sourceOutFrame });
        } else {
          const minEnd = d.seg.clip.startFrame + 1;
          const newEndFrame = Math.max(minEnd, f);
          const deltaFrames = newEndFrame - (d.seg.clip.startFrame + clipDurationFrames(d.seg.clip));
          const newOut = Math.min(assetFrames, Math.max(d.seg.clip.sourceInFrame + 1, Math.round(d.seg.clip.sourceOutFrame + deltaFrames * speed)));
          setDrag({ ...d, newStart: d.seg.clip.startFrame, newIn: d.seg.clip.sourceInFrame, newOut });
        }
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.kind === "move") {
        if (d.ghostStart !== d.seg.clip.startFrame || d.ghostTrack !== d.track.index) {
          onMoveClip(d.clipId, d.ghostStart, d.ghostTrack);
        }
      } else if (d.edge === "l") {
        if (d.newIn !== d.seg.clip.sourceInFrame) onTrimClip(d.clipId, d.newIn, undefined);
        if (d.newStart !== d.seg.clip.startFrame) onMoveClip(d.clipId, d.newStart, d.track.index);
      } else if (d.newOut !== d.seg.clip.sourceOutFrame) {
        onTrimClip(d.clipId, undefined, d.newOut);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Subscribe once per drag (keyed by the dragged clip + mode), not per move —
    // the handlers read the latest state via dragRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.clipId, drag?.kind, snap, snapTargets, frameFromClientX, fps, trackAtClientY, onMoveClip, onTrimClip]);

  const startMove = (e: ReactPointerEvent, track: Track, seg: Segment) => {
    if (track.locked) return;
    e.preventDefault();
    onSelectClip(seg.clip.id);
    const grab = frameFromClientX(e.clientX) - seg.clip.startFrame;
    setDrag({ kind: "move", clipId: seg.clip.id, track, seg, grabFrame: grab, startX: e.clientX, ghostStart: seg.clip.startFrame, ghostTrack: track.index });
  };
  const startTrim = (e: ReactPointerEvent, track: Track, seg: Segment, edge: "l" | "r") => {
    if (track.locked) return;
    e.preventDefault();
    e.stopPropagation();
    onSelectClip(seg.clip.id);
    setDrag({ kind: "trim", clipId: seg.clip.id, track, seg, edge, startX: e.clientX, newStart: seg.clip.startFrame, newIn: seg.clip.sourceInFrame, newOut: seg.clip.sourceOutFrame });
  };

  const splitAtPlayhead = (track: Track, seg: Segment) => {
    if (track.locked) return;
    const phFrame = Math.round(store.get().playhead * fps);
    const local = phFrame - seg.clip.startFrame;
    if (local > 1 && local < clipDurationFrames(seg.clip) - 1) onSplit(seg.clip.id, local);
  };
  const rippleDeleteClip = (track: Track, seg: Segment) => {
    if (track.locked) return;
    onRippleDelete(track.index, seg.clip.startFrame, seg.clip.startFrame + clipDurationFrames(seg.clip));
  };

  const addMarker = () => addMarkerAt(Math.round(store.get().playhead * fps));

  const ticks = useMemo(() => {
    if (total <= 0) return [{ t: 0, x: 0 }];
    const step = tickInterval(pps);
    const out: { t: number; x: number }[] = [];
    for (let t = 0; t <= total + 0.001; t += step) out.push({ t, x: t * pps });
    return out;
  }, [total, pps]);

  return (
    <section className="tl" style={{ height } as CSSProperties}>
      <div className="tl-resizer" role="separator" aria-label="Resize timeline"
        onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />

      <div className="tl-head">
        <span className="panel-title">Timeline</span>
        {justUpdated && <span className="sync-pulse"><span className="dot" /> synced</span>}
        <span className="tl-meta">{clipCount} clip{clipCount === 1 ? "" : "s"} · {rows.length} track{rows.length === 1 ? "" : "s"} · {fmtTime(total)}</span>
        <span className="tl-spacer" />
        <TransportClock store={store} />
        <button className="icon-btn sm" onClick={addMarker} aria-label="Add marker at playhead" title="Add marker at playhead (or double-click the ruler)"><span className="tl-marker-add">◆</span></button>
        <div className="tl-zoom" role="group" aria-label="Timeline horizontal scale">
          <button className="icon-btn sm" onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.5))} aria-label="Zoom out" title="Zoom out — show more time"><ZoomOut size={15} /></button>
          <input
            type="range" className="tl-zoom-slider" min={MIN_PPS} max={MAX_PPS} step={1} value={pps}
            onChange={(e) => setPps(Number(e.target.value))}
            aria-label="Horizontal scale" title="Horizontal scale — drag, or Ctrl/⌘ + scroll over the timeline"
          />
          <button className="zoom-fit" onClick={fit} title="Fit to window">Fit</button>
          <button className="icon-btn sm" onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.5))} aria-label="Zoom in" title="Zoom in — show finer detail"><ZoomIn size={15} /></button>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-gutter" style={{ width: GUTTER_W } as CSSProperties}>
          <div className="tl-gutter-ruler" style={{ height: RULER_H } as CSSProperties}>
            <div className="tl-addtrack">
              <button onClick={() => onAddTrack("video")} title="Add video track" aria-label="Add video track"><Plus size={11} /> V</button>
              <button onClick={() => onAddTrack("audio")} title="Add audio track" aria-label="Add audio track"><Plus size={11} /> A</button>
            </div>
          </div>
          {rows.map((t) => (
            <TrackHeader
              key={t.id} track={t} connected={connected}
              segs={laneSegs.get(t.index) ?? []} store={store}
              onSet={(patch) => onSetTrack(t.index, patch)}
              onRemove={() => onRemoveTrack(t.index)}
            />
          ))}
          {elLanes.text.length > 0 && (
            <div className="tl-gutter-ellane text" style={{ height: ELEM_LANE_H } as CSSProperties}><Type size={11} /> Text</div>
          )}
          {elLanes.gfx.length > 0 && (
            <div className="tl-gutter-ellane gfx" style={{ height: ELEM_LANE_H } as CSSProperties}><Sparkles size={11} /> Graphics</div>
          )}
          {elLanes.cap.length > 0 && (
            <div className="tl-gutter-ellane cap" style={{ height: ELEM_LANE_H } as CSSProperties}><Captions size={11} /> Captions</div>
          )}
          {music && musicAsset && (
            <div className="tl-gutter-lane music" style={{ height: MUSIC_H } as CSSProperties}>
              <span className="tl-lane-kind">BG</span><Music size={11} />
            </div>
          )}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" ref={contentRef} style={{ width: contentW } as CSSProperties}>
            <div className="tl-ruler" style={{ height: RULER_H } as CSSProperties}
              onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp}
              onDoubleClick={(e) => addMarkerAt(frameFromClientX(e.clientX))}>
              {ticks.map((tick, i) => (
                <span key={i} className="tl-tick" style={{ left: tick.x }}><span className="tl-tick-label">{fmtTime(tick.t)}</span></span>
              ))}
              {markers.map((m) => (
                <span key={m.frame} className="tl-marker"
                  style={{ left: (m.frame / fps) * pps, ...(m.color ? { background: m.color } : {}) } as CSSProperties}
                  title={[
                    m.name ? `${m.name} — ${fmtTime(m.frame / fps)}` : `Marker ${fmtTime(m.frame / fps)}`,
                    m.note,
                    "click to seek, alt-click to remove",
                  ].filter(Boolean).join("\n")}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.altKey) removeMarkerAt(m.frame);
                    else onSeek(m.frame / fps);
                  }} />
              ))}
            </div>

            {rows.map((t) => {
              const segs = laneSegs.get(t.index) ?? [];
              const h = trackHeight(t);
              return (
                <div key={t.id} className={`tl-lane ${t.kind} ${t.locked ? "locked" : ""}`} style={{ height: h } as CSSProperties}
                  ref={(el) => { if (el) laneEls.current.set(t.index, el); else laneEls.current.delete(t.index); }}
                  onPointerDown={(e) => { if (e.target === e.currentTarget) onScrubDown(e); }}
                  onPointerMove={onScrubMove} onPointerUp={onScrubUp}>
                  {segs.length === 0 && t.kind === "video" && t.index === Math.min(...rows.filter((r) => r.kind === "video").map((r) => r.index)) && (
                    <div className="tl-empty"><Scissors size={15} /><span>Add clips from the library, or let your AI client build the edit.</span></div>
                  )}
                  {segs.map((seg) => (
                    <ClipBlock
                      key={seg.clip.id} seg={seg} track={t} pps={pps} fps={fps} rowH={h}
                      thumb={seg.asset ? thumbs[seg.asset.id] : undefined}
                      selected={selectedClip === seg.clip.id}
                      drag={drag}
                      onBodyDown={(e) => startMove(e, t, seg)}
                      onTrimDown={(e, edge) => startTrim(e, t, seg, edge)}
                      onSplit={() => splitAtPlayhead(t, seg)}
                      onRipple={() => rippleDeleteClip(t, seg)}
                      onRemove={() => onRemove(seg.clip.id)}
                      onSelect={() => onSelectClip(seg.clip.id)}
                    />
                  ))}
                </div>
              );
            })}

            {elLanes.text.length > 0 && (
              <div className="tl-ellane text" style={{ height: ELEM_LANE_H, width: total * pps } as CSSProperties}>
                {elLanes.text.map((b) => <LaneElementBar key={`t-${b.clipId}-${b.ref}`} kind="text" bar={b} pps={pps} fps={fps} onCommit={onSetElementWindow} />)}
              </div>
            )}
            {elLanes.gfx.length > 0 && (
              <div className="tl-ellane gfx" style={{ height: ELEM_LANE_H, width: total * pps } as CSSProperties}>
                {elLanes.gfx.map((b) => <LaneElementBar key={`g-${b.clipId}-${b.ref}`} kind="gfx" bar={b} pps={pps} fps={fps} onCommit={onSetElementWindow} />)}
              </div>
            )}
            {elLanes.cap.length > 0 && (
              <div className="tl-ellane cap" style={{ height: ELEM_LANE_H, width: total * pps } as CSSProperties}>
                {elLanes.cap.map((b) => <LaneElementBar key={`c-${b.clipId}-${b.ref}`} kind="cap" bar={b} pps={pps} fps={fps} onCommit={onSetElementWindow} />)}
              </div>
            )}

            {music && musicAsset && (
              <div className="tl-lane music" style={{ height: MUSIC_H } as CSSProperties}
                onPointerDown={(e) => { if (e.target === e.currentTarget) onScrubDown(e); }} onPointerMove={onScrubMove} onPointerUp={onScrubUp}>
                <div className="tl-music" style={{ left: 0, width: total * pps } as CSSProperties} title={`Music: ${musicAsset.name}`}>
                  <Music size={11} /><span className="tl-music-name">{musicAsset.name}</span>
                  {music.duck && <span className="tl-music-tag">duck</span>}
                </div>
              </div>
            )}

            {/* Move ghost */}
            {drag?.kind === "move" && (
              <MoveGhost drag={drag} rows={rows} pps={pps} fps={fps} laneEls={laneEls} contentRef={contentRef} />
            )}

            <Playhead store={store} pps={pps} />
          </div>
        </div>
      </div>

      {!connected && <div className="tl-offline">Waiting for the editor core…</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
function TrackHeader({
  track, connected, segs, store, onSet, onRemove,
}: {
  track: Track; connected: boolean; segs: Segment[]; store: PlaybackStore;
  onSet: (patch: Record<string, unknown>) => void; onRemove: () => void;
}) {
  const h = trackHeight(track);
  const label = track.name ?? `${track.kind === "video" ? "V" : "A"}${track.index + 1}`;
  return (
    <div className={`tl-thead ${track.kind} ${track.locked ? "locked" : ""}`} style={{ height: h } as CSSProperties}>
      <div className="tl-thead-row">
        <span className="tl-thead-name" title={label}>{label}</span>
        <div className="tl-thead-btns">
          <button className={`thead-btn ${track.muted ? "on" : ""}`} disabled={!connected}
            onClick={() => onSet({ muted: !track.muted })} aria-label="Mute track" title={track.muted ? "Unmute" : "Mute"}>
            {track.muted ? <VolumeX size={13} /> : <Volume size={13} />}
          </button>
          {track.kind === "video" && (
            <button className={`thead-btn ${track.hidden ? "on" : ""}`} disabled={!connected}
              onClick={() => onSet({ hidden: !track.hidden })} aria-label="Hide track" title={track.hidden ? "Show" : "Hide"}>
              {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
          <button className={`thead-btn ${track.locked ? "on" : ""}`} disabled={!connected}
            onClick={() => onSet({ locked: !track.locked })} aria-label="Lock track" title={track.locked ? "Unlock" : "Lock"}>
            <Lock size={12} />
          </button>
          <button className="thead-btn danger" disabled={!connected} onClick={onRemove} aria-label="Remove track" title="Remove track"><X size={12} /></button>
        </div>
      </div>
      {track.kind === "audio" && h >= AUDIO_H && (
        <div className="tl-thead-audio">
          <input type="range" min={0} max={2} step={0.05} defaultValue={track.volume ?? 1}
            key={`tv-${track.index}-${track.volume ?? 1}`} aria-label="Track volume" title="Track volume"
            onChange={(e) => onSet({ volume: Number(e.target.value) })} disabled={!connected || track.muted} />
          <TrackMeter segs={segs} store={store} muted={!!track.muted} volume={track.volume ?? 1} />
        </div>
      )}
    </div>
  );
}

/** A compact level meter driven by waveform peaks at the playhead (no live audio tap needed). */
function TrackMeter({ segs, store, muted, volume }: { segs: Segment[]; store: PlaybackStore; muted: boolean; volume: number }) {
  const ph = usePlaybackValue(store, (s) => s.playhead);
  const playing = usePlaybackValue(store, (s) => s.playing);
  // Find the audio segment under the playhead and read its peak there (peaks are
  // decoded per-clip in ClipBlock and shared via segPeaksCache).
  const seg = segs.find((s) => ph >= s.start && ph < s.end);
  let level = 0;
  if (seg && !muted && playing) {
    const frac = seg.tlDur > 0 ? (ph - seg.start) / seg.tlDur : 0;
    const cp = clipPeaks(seg);
    level = cp ? peakRange(cp, frac - 0.01, frac + 0.01) * volume * (seg.clip.effects?.volume ?? 1) : 0;
  }
  return (
    <div className="tl-meter" aria-hidden="true">
      <div className="tl-meter-fill" style={{ transform: `scaleX(${Math.min(1, level)})` } as CSSProperties} />
    </div>
  );
}

// Lightweight shared cache lookup so the meter can read a clip's peaks without a hook.
const segPeaksCache = new WeakMap<MediaAsset, Float32Array>();
function clipPeaks(seg: Segment): Float32Array | null {
  if (!seg.asset) return null;
  return segPeaksCache.get(seg.asset) ?? null;
}

// ---------------------------------------------------------------------------
function ClipBlock({
  seg, track, pps, fps, rowH, thumb, selected, drag, onBodyDown, onTrimDown, onSplit, onRipple, onRemove, onSelect,
}: {
  seg: Segment; track: Track; pps: number; fps: number; rowH: number; thumb?: string; selected: boolean;
  drag: Drag | null;
  onBodyDown: (e: ReactPointerEvent) => void;
  onTrimDown: (e: ReactPointerEvent, edge: "l" | "r") => void;
  onSplit: () => void; onRipple: () => void; onRemove: () => void; onSelect: () => void;
}) {
  const isAudio = track.kind === "audio";
  // Waveforms on audio clips (audio tracks or audio-only assets). Video clips
  // show a thumbnail instead — no need to fetch/decode large video files.
  const wantWave = isAudio || (!!seg.asset && !seg.asset.hasVideo);
  const peaks = usePeaks(wantWave ? seg.path : undefined);
  useEffect(() => { if (peaks && seg.asset) segPeaksCache.set(seg.asset, peaks); }, [peaks, seg.asset]);

  // Live position/size while this clip is being dragged or trimmed.
  let startFrame = seg.clip.startFrame;
  let durFrames = clipDurationFrames(seg.clip);
  let dragging = false;
  if (drag && drag.clipId === seg.clip.id) {
    dragging = true;
    if (drag.kind === "trim") {
      startFrame = drag.newStart;
      durFrames = Math.max(1, Math.round((drag.newOut - drag.newIn) / seg.speed));
    } else {
      // Move ghost is drawn separately; keep the source block dimmed in place.
    }
  }
  const left = (startFrame / fps) * pps + 1;
  const w = Math.max(3, (durFrames / fps) * pps - 2);

  const muted = (seg.clip.effects?.volume ?? 1) === 0 || track.muted;
  const nKf = seg.clip.keyframes ? Object.keys(seg.clip.keyframes).length : 0;
  const hasTransform = !!seg.clip.effects?.transform || (seg.clip.effects?.opacity !== undefined && seg.clip.effects.opacity !== 1);

  return (
    <div
      className={`tl-clip ${isAudio ? "audio" : ""} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${drag?.kind === "move" && drag.clipId === seg.clip.id ? "ghosted" : ""}`}
      style={{ left, width: w } as CSSProperties}
      onPointerDown={onBodyDown}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      role="button" tabIndex={0} title={seg.asset?.name}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
    >
      <span className="tl-trim l" onPointerDown={(e) => onTrimDown(e, "l")} aria-label="Trim start" />
      <span className="tl-trim r" onPointerDown={(e) => onTrimDown(e, "r")} aria-label="Trim end" />

      {!isAudio && <div className="tl-clip-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />}
      {peaks && <ClipWave peaks={peaks} seg={seg} fps={fps} width={w} height={rowH} />}

      {/* Keyframe / transform indicator only — text, captions, graphics and the
          transition are shown as labeled bars on the element rail below. */}
      {(nKf > 0 || hasTransform) && (
        <div className="tl-clip-badges">
          <span className="tl-badge" title={nKf > 0 ? `${nKf} animated propert${nKf === 1 ? "y" : "ies"}` : "Transformed"}>◆</span>
        </div>
      )}

      <div className="tl-clip-body">
        <span className="tl-clip-name"><span className="tl-clip-idx">{seg.index + 1}</span>{seg.clip.adjustment ? "Adjustment" : seg.asset?.name ?? "—"}</span>
        <span className={`tl-clip-meta ${muted ? "muted" : ""}`}>
          {seg.asset?.hasAudio && <Waveform size={11} />}
          <span className="tl-clip-dur">{fmtTime(durFrames / fps)}</span>
        </span>
      </div>

      {/* Transition entering this clip (text/captions/graphics now live on their
          own lanes below the video tracks, not over the footage). */}
      {seg.clip.transition && (
        <span className="tl-trans" title={`Transition in: ${seg.clip.transition.type} · ${(seg.clip.transition.durationFrames / fps).toFixed(2)}s`} />
      )}

      <div className="tl-clip-tools">
        <button className="tl-tool" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSplit(); }} aria-label="Split at playhead" title="Split at playhead"><Scissors size={12} /></button>
        <button className="tl-tool" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRipple(); }} aria-label="Ripple delete" title="Ripple delete (close the gap)"><span className="tl-ripple-ic">⇥</span></button>
        <button className="tl-tool danger" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label="Remove clip" title="Remove"><X size={13} /></button>
      </div>
    </div>
  );
}

/**
 * One element bar on a dedicated lane (text / graphics / captions), positioned by
 * its ABSOLUTE timeline range. Text & graphic bars are draggable — drag the body
 * to move, an edge to resize — clamped to the owning clip, committed as clip-local
 * frames. Caption bars are shown but not dragged (cues auto-follow the speech).
 */
function LaneElementBar({
  kind, bar, pps, fps, onCommit,
}: {
  kind: "text" | "gfx" | "cap"; bar: LaneBar; pps: number; fps: number;
  onCommit: Props["onSetElementWindow"];
}) {
  const pxPerFrame = pps / fps;
  const draggable = kind !== "cap";
  const [local, setLocal] = useState<{ s: number; e: number } | null>(null);
  const absS = local?.s ?? bar.absS;
  const absE = local?.e ?? bar.absE;

  const begin = (mode: "move" | "l" | "r") => (ev: ReactPointerEvent) => {
    ev.stopPropagation();
    if (!draggable) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const s0 = bar.absS, e0 = bar.absE, span = e0 - s0;
    const lo = bar.clipStart, hi = bar.clipStart + bar.clipDur;
    let last = { s: s0, e: e0 };
    const move = (m: PointerEvent) => {
      const df = Math.round((m.clientX - startX) / Math.max(0.001, pxPerFrame));
      if (mode === "move") { const ns = Math.max(lo, Math.min(hi - span, s0 + df)); last = { s: ns, e: ns + span }; }
      else if (mode === "l") { last = { s: Math.max(lo, Math.min(e0 - 1, s0 + df)), e: e0 }; }
      else { last = { s: s0, e: Math.max(s0 + 1, Math.min(hi, e0 + df)) }; }
      setLocal(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLocal(null);
      if (last.s !== s0 || last.e !== e0) onCommit(kind === "gfx" ? "graphic" : kind, bar.clipId, bar.ref, last.s - bar.clipStart, last.e - bar.clipStart);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const left = (absS / fps) * pps;
  const width = Math.max(8, ((absE - absS) / fps) * pps);
  const title = `${kind === "text" ? "Text" : kind === "gfx" ? "Motion graphic" : "Caption"}: ${bar.full ?? bar.label}`;
  return (
    <span className={`tl-elbar ${kind} ${draggable ? "drag" : ""}`} title={title}
      style={{ left, width } as CSSProperties} onPointerDown={begin("move")}>
      {draggable && <span className="tl-elbar-h l" onPointerDown={begin("l")} aria-label="Resize start" />}
      {bar.label && <span className="tl-elbar-lbl">{bar.label}</span>}
      {draggable && <span className="tl-elbar-h r" onPointerDown={begin("r")} aria-label="Resize end" />}
    </span>
  );
}

/** Canvas waveform for a clip, drawing its source slice of the asset peaks. */
function ClipWave({ peaks, seg, fps, width, height }: { peaks: Float32Array; seg: Segment; fps: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round(height));
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const dur = seg.asset?.duration ?? 1;
    const inFrac = seg.clip.sourceInFrame / fps / dur;
    const outFrac = seg.clip.sourceOutFrame / fps / dur;
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const f = inFrac + (outFrac - inFrac) * (x / W);
      const p = peakRange(peaks, f - 0.001, f + 0.001);
      const half = Math.max(0.5, p * (H / 2 - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, [peaks, seg.clip.sourceInFrame, seg.clip.sourceOutFrame, seg.asset, fps, width, height]);
  return <canvas ref={ref} className="tl-wave" />;
}

/** The translucent block that follows the pointer while moving a clip. */
function MoveGhost({
  drag, rows, pps, fps, laneEls, contentRef,
}: {
  drag: Extract<Drag, { kind: "move" }>; rows: Track[]; pps: number; fps: number;
  laneEls: MutableRefObject<Map<number, HTMLElement>>; contentRef: RefObject<HTMLDivElement>;
}) {
  const dur = clipDurationFrames(drag.seg.clip);
  const left = (drag.ghostStart / fps) * pps + 1;
  const w = Math.max(3, (dur / fps) * pps - 2);
  const laneEl = laneEls.current.get(drag.ghostTrack);
  const content = contentRef.current;
  let top = 0;
  let h = VIDEO_H;
  if (laneEl && content) {
    const lr = laneEl.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    top = lr.top - cr.top;
    h = lr.height;
  }
  const t = rows.find((r) => r.index === drag.ghostTrack);
  return (
    <div className={`tl-ghost ${t?.kind ?? "video"}`} style={{ left, width: w, top, height: h } as CSSProperties}>
      <span className="tl-ghost-name">{drag.seg.asset?.name ?? "Clip"}</span>
    </div>
  );
}

function Playhead({ store, pps }: { store: PlaybackStore; pps: number }) {
  const ph = usePlaybackValue(store, (s) => s.playhead);
  return (
    <div className="tl-playhead" style={{ transform: `translateX(${ph * pps}px)` } as CSSProperties} aria-hidden="true">
      <span className="tl-playhead-head" />
    </div>
  );
}

function TransportClock({ store }: { store: PlaybackStore }) {
  const ph = usePlaybackValue(store, (s) => s.playhead);
  const dur = usePlaybackValue(store, (s) => s.duration);
  return (
    <span className="tl-clock">
      <span className="tl-clock-now">{fmtTime(ph, true)}</span>
      <span className="tl-clock-sep">/</span>
      <span className="tl-clock-dur">{fmtTime(dur, true)}</span>
    </span>
  );
}
