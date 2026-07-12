import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CoreApi } from "./api";
import type { Clip, ColorInspection, KeyframeProperty, Marker, MediaAsset, Project, ProgressInfo, TextStyle, TranscriptHit, VisualEffect, VisualHit } from "./types";
import { clipDurationFrames } from "./types";
import {
  buildSegments, createPlaybackStore, fmtTime, usePlaybackValue,
  type PlayerHandle,
} from "./playback";
import { PreviewPlayer } from "./preview";
import { Timeline } from "./timeline";
import {
  Alert, Bot, Captions, Check, ChevronRight, Clock, Crop, Export,
  Film, FolderPlus, Frame, Import, Music, Pause, Play, Plus, Redo, RotateCcw, Scissors,
  Search, SkipEnd, SkipStart, Sliders, Sparkles, Trash, Type, Undo, Waveform, X,
} from "./icons";
import reloLogo from "./assets/relo-logo.png";

function fmt(seconds: number): string {
  return fmtTime(seconds);
}

function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const ASPECT_PRESETS = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
];

// Export presets surfaced in the Export menu (mirror packages/core EXPORT_PRESETS).
const EXPORT_PRESETS = [
  { id: "youtube", label: "YouTube", desc: "H.264 MP4 · high quality" },
  { id: "youtube_hevc", label: "YouTube HEVC", desc: "H.265 MP4 · smaller" },
  { id: "social", label: "Reels / Shorts / TikTok", desc: "H.264 MP4 · faststart" },
  { id: "square", label: "Square", desc: "H.264 MP4" },
  { id: "web", label: "Web (WebM)", desc: "VP9 / Opus" },
  { id: "master", label: "Master", desc: "near-lossless MOV" },
];

// All transition types the core supports, grouped so the picker reads as an
// organized menu rather than a flat dump (mirrors TRANSITION_TYPES in core/rpc.ts).
const TRANSITION_GROUPS: { label: string; types: string[] }[] = [
  { label: "Fade", types: ["fade", "dissolve", "fadeblack", "fadewhite"] },
  { label: "Wipe", types: ["wipeleft", "wiperight", "wipeup", "wipedown"] },
  { label: "Slide", types: ["slideleft", "slideright", "smoothleft", "smoothright"] },
  { label: "Shape", types: ["circleopen", "circleclose", "radial"] },
];

// Motion graphics are AUTHORED BY THE AI via the MCP `add_graphic` tool (it reads
// the clip with inspect_clip / get_frame, writes a Remotion component, and places
// it at an exact frame window). There is intentionally no human code-entry UI —
// the inspector only lists/removes the graphics the AI created.

const CAPTION_MODELS = ["tiny.en", "base.en", "small.en", "medium.en", "large-v3-turbo"];
const TEXT_POSITIONS = ["bottom", "top", "center", "topleft", "topright", "bottomleft", "bottomright"];
// Presets are a renderer-side convenience for the human; they send explicit
// style fields (the core schema is fully open, no preset enum — the AI composes
// styles freely the same way).
const CAPTION_PRESETS: { id: string; label: string; style: Record<string, unknown> }[] = [
  { id: "subtitle", label: "Subtitle", style: { position: "bottom", fontSize: 42, color: "#ffffff", box: true, boxColor: "#000000aa", outlineWidth: 0, shadowX: 0, shadowY: 0 } },
  { id: "bold", label: "Bold", style: { position: "center", fontSize: 72, color: "#ffffff", box: false, outlineColor: "#000000", outlineWidth: 3, shadowX: 0, shadowY: 0 } },
  { id: "karaoke", label: "Karaoke", style: { position: "bottom", fontSize: 56, color: "#ffe14d", box: true, boxColor: "#000000cc", outlineColor: "#000000", outlineWidth: 2, shadowX: 0, shadowY: 0 } },
  { id: "minimal", label: "Minimal", style: { position: "bottom", fontSize: 34, color: "#ffffff", box: false, outlineWidth: 0, shadowColor: "#000000", shadowX: 1, shadowY: 1 } },
  { id: "cinematic", label: "Cinematic", style: { position: "bottom", fontSize: 40, color: "#f2f2f2", box: true, boxColor: "#0a0a0a99", outlineWidth: 0, shadowX: 0, shadowY: 0 } },
];

export function App({ api }: { api: CoreApi }) {
  const [connected, setConnected] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [exactSrc, setExactSrc] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [showConnect, setShowConnect] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  const [scopes, setScopes] = useState<ColorInspection | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [folderFilter, setFolderFilter] = useState<string | null>(null); // null = All
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"words" | "visuals">("words");
  const [searchHits, setSearchHits] = useState<TranscriptHit[] | null>(null);
  const [visualHits, setVisualHits] = useState<{ semantic: boolean; refName: string; hits: VisualHit[] } | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const lastRevision = useRef<number | null>(null);
  // ---- project files (New / Open / Save / Save As / Recent + autosave) ----
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("aive.recent") || "[]"); } catch { return []; }
  });
  // The next state we receive becomes the "clean" baseline (after New/Open/Save).
  const pendingBaseline = useRef(true);
  const savedRev = useRef<number | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const store = useRef(createPlaybackStore()).current;
  const playerRef = useRef<PlayerHandle>(null);
  const playing = usePlaybackValue(store, (s) => s.playing);

  useEffect(() => {
    api.onStatus(setConnected);
    api.onState((p, fp) => { setProject(p); setProjectPath(fp); });
    api.onProgress((p) => setProgress(p.fraction >= 1 ? null : p));
  }, [api]);

  // Track unsaved changes: the first state after New/Open/Save is the clean
  // baseline; any later revision bump means the project has unsaved edits.
  useEffect(() => {
    if (!project) return;
    if (pendingBaseline.current) {
      pendingBaseline.current = false;
      savedRev.current = project.revision;
      setDirty(false);
    } else {
      setDirty(project.revision !== savedRev.current);
    }
  }, [project]);

  // Flash a "synced" pulse whenever the project changes — so it's obvious when
  // the AI (or a manual action) just edited the timeline.
  useEffect(() => {
    if (!project) return;
    if (lastRevision.current !== null && project.revision !== lastRevision.current) {
      setJustUpdated(true);
      const t = setTimeout(() => setJustUpdated(false), 1200);
      lastRevision.current = project.revision;
      return () => clearTimeout(t);
    }
    lastRevision.current = project.revision;
  }, [project]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setError(null);
      setBusy(label);
      try {
        return await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const fps = project?.fps ?? 30;
  // The instant preview / timeline render the BASE (lowest-index) video track.
  // Full multi-track timeline UI lands in a later phase.
  const videoTrack = useMemo(
    () => (project?.tracks ?? []).filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0],
    [project],
  );
  const clips = useMemo(() => videoTrack?.clips ?? [], [videoTrack]);
  const assetById = useMemo(() => {
    const map = new Map<string, MediaAsset>();
    project?.assets.forEach((a) => map.set(a.id, a));
    return map;
  }, [project]);
  const folders = useMemo(() => [...(project?.folders ?? [])].sort((a, b) => a.createdAt - b.createdAt), [project]);
  const visibleAssets = useMemo(() => {
    const all = project?.assets ?? [];
    if (folderFilter === null) return all;
    if (folderFilter === "__none__") return all.filter((a) => !a.folderId);
    return all.filter((a) => a.folderId === folderFilter);
  }, [project, folderFilter]);

  const segments = useMemo(() => buildSegments(clips, assetById, fps), [clips, assetById, fps]);
  const totalDuration = useMemo(
    () => segments.reduce((m, seg) => Math.max(m, seg.end), 0),
    [segments],
  );

  // Fetch thumbnails for assets that don't have one yet.
  useEffect(() => {
    if (!project) return;
    for (const asset of project.assets) {
      if (thumbs[asset.id] || !asset.hasVideo) continue;
      api
        .rpc<{ path: string }>("generate_thumbnail", { assetId: asset.id, atSeconds: 0 })
        // NB: fileUrl already contains `?path=…`, so the cache-buster must use
        // `&` — `?v=` here glues onto the path value and 404s the thumbnail.
        .then((r) => setThumbs((t) => ({ ...t, [asset.id]: `${api.fileUrl(r.path)}&v=${Date.now()}` })))
        .catch(() => {});
    }
  }, [project, api, thumbs]);

  const importMedia = () =>
    run("Importing", async () => {
      let paths: string[] = [];
      if (window.aive) paths = await window.aive.pickFiles();
      else {
        const p = window.prompt("Absolute path to a media file:");
        if (p) paths = [p];
      }
      for (const path of paths) await api.rpc("import_video", { path });
    });

  const addToTimeline = (assetId: string) => run("Adding clip", () => api.rpc("append_clip", { assetId }));
  const removeAsset = (assetId: string) => run("Removing asset", () => api.rpc("remove_asset", { assetId }));
  // ---- Phase 6: media intelligence ----
  // Electron disables window.prompt(), so the folder name is entered inline.
  const submitFolder = () => {
    const name = folderName.trim();
    if (name) run("New folder", () => api.rpc("create_folder", { name }));
    setFolderName("");
    setAddingFolder(false);
  };
  const moveToFolder = (assetId: string, folderId: string | null) =>
    run("Move to folder", () => api.rpc("move_asset_to_folder", { assetId, folderId }));
  const renameFolder = (folderId: string, name: string) => {
    const n = name.trim();
    if (n) run("Rename folder", () => api.rpc("rename_folder", { folderId, name: n }));
  };
  const deleteFolder = (folderId: string) => {
    if (folderFilter === folderId) setFolderFilter(null);
    run("Delete folder", () => api.rpc("delete_folder", { folderId }));
  };
  const indexAsset = (assetId: string, kinds: { transcript?: boolean; visual?: boolean }) =>
    run("Indexing media", async () => {
      const asset = project?.assets.find((a) => a.id === assetId);
      if (kinds.transcript && asset?.hasAudio) await api.rpc("index_transcript", { assetId });
      if (kinds.visual && asset?.hasVideo) await api.rpc("index_visual", { assetId });
    });
  const runSearch = () => {
    const q = query.trim();
    if (!q) { setSearchHits(null); setVisualHits(null); return; }
    if (searchMode === "visuals") {
      run("Searching shots (semantic)", async () => {
        const r = await api.rpc<{ semantic: boolean; hits: VisualHit[] }>("search_visual", { query: q });
        setVisualHits({ semantic: r.semantic, refName: `"${q}"`, hits: r.hits });
        setSearchHits(null);
      });
      return;
    }
    run("Searching transcripts", async () => {
      const r = await api.rpc<{ hits: TranscriptHit[] }>("search_transcript", { query: q });
      setSearchHits(r.hits);
      setVisualHits(null);
    });
  };
  const findSimilar = (assetId: string, name: string) =>
    run("Finding similar shots", async () => {
      const r = await api.rpc<{ semantic: boolean; hits: VisualHit[] }>("search_visual", { assetId, atSeconds: 0 });
      setVisualHits({ semantic: r.semantic, refName: name, hits: r.hits.filter((h) => h.assetId !== assetId) });
      setSearchHits(null);
    });
  const removeClip = (clipId: string) => run("Removing clip", () => api.rpc("remove_clip", { clipId }));
  // Drag a clip to an absolute startFrame, optionally onto another track.
  const moveClipTo = (clipId: string, startFrame: number, trackIndex: number) =>
    run("Moving clip", () => api.rpc("move_clip", { clipId, startFrame, trackIndex }));
  // Drag-trim a clip's edges (frames within the source).
  const trimClipEdge = (clipId: string, sourceInFrame?: number, sourceOutFrame?: number) =>
    run("Trimming", () => api.rpc("trim_clip", { clipId, sourceInFrame, sourceOutFrame }));
  // Split at a clip-local timeline frame (playhead → clip-local handled by the timeline).
  const splitClipAt = (clipId: string, atLocalFrame: number) =>
    run("Splitting", () => api.rpc("split_clip", { clipId, atFrame: atLocalFrame }));
  const rippleDelete = (trackIndex: number, startFrame: number, endFrame: number) =>
    run("Ripple delete", () => api.rpc("ripple_delete_ranges", { ranges: [{ trackIndex, startFrame, endFrame }] }));
  const setTrackProps = (trackIndex: number, patch: Record<string, unknown>) =>
    run("Track", () => api.rpc("set_track_properties", { trackIndex, ...patch }));
  const addTrack = (kind: "video" | "audio") => run("Add track", () => api.rpc("add_track", { kind }));
  const setMarkers = (markers: Marker[]) => run("Markers", () => api.rpc("set_markers", { frames: markers }));
  const removeTrack = (trackIndex: number) => run("Remove track", () => api.rpc("remove_track", { trackIndex }));
  const setAspect = (width: number, height: number) =>
    run("Setting aspect", () => api.rpc("set_project_settings", { width, height }));
  const undo = () => run("Undo", () => api.rpc("undo"));
  const redo = () => run("Redo", () => api.rpc("redo"));

  // ---- project files -------------------------------------------------------
  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const pushRecent = useCallback((path: string) => {
    setRecents((r) => {
      const next = [path, ...r.filter((p) => p !== path)].slice(0, 8);
      try { localStorage.setItem("aive.recent", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const newProject = async () => {
    setShowProjectMenu(false);
    if (dirty && !window.confirm("Discard unsaved changes and start a new project?")) return;
    pendingBaseline.current = true;
    await run("New project", () => api.rpc("new_project"));
  };
  const openProjectPath = async (path: string) => {
    setShowProjectMenu(false);
    if (dirty && !window.confirm("Discard unsaved changes and open another project?")) return;
    pendingBaseline.current = true;
    const ok = await run("Opening project", () => api.rpc("load_project", { path }));
    if (ok !== null) pushRecent(path);
  };
  const openProject = async () => {
    let path: string | null = null;
    if (window.aive) path = await window.aive.openProject();
    else path = window.prompt("Absolute path to a .aive project:");
    if (path) await openProjectPath(path);
  };
  const saveProjectAs = async () => {
    setShowProjectMenu(false);
    let path: string | null = null;
    if (window.aive) path = await window.aive.saveProjectAs(project?.name || "Untitled");
    else path = window.prompt("Absolute path to save (.aive):");
    if (!path) return;
    pendingBaseline.current = true;
    const ok = await run("Saving project", () => api.rpc("save_project", { path }));
    if (ok !== null) pushRecent(path);
  };
  const saveProject = async () => {
    setShowProjectMenu(false);
    if (!projectPath) { await saveProjectAs(); return; }
    pendingBaseline.current = true;
    const ok = await run("Saving project", () => api.rpc("save_project", { path: projectPath }));
    if (ok !== null) pushRecent(projectPath);
  };
  saveRef.current = saveProject;

  // Autosave: once a project has a file, silently re-save a few seconds after
  // the last edit so switching away / a crash never loses a named project.
  useEffect(() => {
    if (!dirty || !projectPath || !connected) return;
    const t = setTimeout(() => {
      pendingBaseline.current = true;
      api.rpc("save_project", { path: projectPath }).catch(() => {});
    }, 4000);
    return () => clearTimeout(t);
  }, [dirty, projectPath, connected, api]);

  // Ctrl/⌘+S saves (separate listener so it works even while a field is focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveRef.current(); }
      // Block whole-UI page zoom (Ctrl +/-/0). Only the timeline zooms.
      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // This is a desktop app, not a web page: never let Ctrl+wheel / pinch zoom the
  // ENTIRE UI (that stretched the preview/library and broke horizontal scroll).
  // The timeline keeps its own Ctrl+wheel zoom (handled inside the timeline).
  useEffect(() => {
    const noPageZoom = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };
    window.addEventListener("wheel", noPageZoom, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", noPageZoom, { capture: true } as EventListenerOptions);
  }, []);

  // Warn before leaving with unsaved changes in a never-saved project (named
  // projects autosave, so they're already safe). Electron's main process also
  // guards quit via reportProjectState below; this covers a plain browser run.
  useEffect(() => {
    if (!dirty || projectPath || window.aive) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, projectPath]);

  // Native top-menu (File/Edit) actions → the same project handlers. Registered
  // once; dispatch via a ref so it always calls the latest closures.
  const menuActionRef = useRef<(a: string) => void>(() => {});
  menuActionRef.current = (action: string) => {
    if (action === "new") newProject();
    else if (action === "open") openProject();
    else if (action === "save") saveProject();
    else if (action === "save-as") saveProjectAs();
    else if (action === "undo") undo();
    else if (action === "redo") redo();
  };
  useEffect(() => {
    window.aive?.onMenu?.((action) => menuActionRef.current(action));
  }, []);

  // Mirror dirty/has-file state to the Electron main process for its quit guard.
  useEffect(() => {
    window.aive?.reportProjectState?.({ dirty, hasPath: !!projectPath });
  }, [dirty, projectPath]);

  const renderExact = () =>
    run("Rendering exact composite", async () => {
      const r = await api.rpc<{ path: string }>("render_preview");
      setExactSrc(`${api.fileUrl(r.path)}&v=${Date.now()}`);
    });

  const exportVideo = (preset?: string) => {
    setShowExport(false);
    return run("Exporting", async () => {
      let out: string | null = null;
      if (window.aive) out = await window.aive.pickSavePath();
      else out = window.prompt("Absolute output path (.mp4):");
      if (!out) return;
      const r = await api.rpc<{ path: string; duration: number }>("export_video", { outputPath: out, ...(preset ? { preset } : {}) });
      setError(null);
      alert(`Exported ${fmt(r.duration)} video to:\n${r.path}`);
    });
  };

  const trimClip = (clipId: string, field: "sourceIn" | "sourceOut", value: number) =>
    run("Trimming", () => {
      const key = field === "sourceIn" ? "sourceInFrame" : "sourceOutFrame";
      return api.rpc("trim_clip", { clipId, [key]: Math.round(value * fps) });
    });
  const setSpeed = (clipId: string, speed: number) => run("Speed", () => api.rpc("set_clip_speed", { clipId, speed }));
  const setVolume = (clipId: string, volume: number) => run("Volume", () => api.rpc("set_clip_volume", { clipId, volume }));
  const setFade = (clipId: string, fadeIn: number, fadeOut: number) =>
    run("Fade", () => api.rpc("set_clip_fade", { clipId, fadeInFrames: Math.round(fadeIn * fps), fadeOutFrames: Math.round(fadeOut * fps) }));
  const setColor = (clipId: string, patch: Record<string, number>) =>
    run("Color", () => api.rpc("color_grade", { clipId, ...patch }));
  // Richer secondary grade: white balance / hue / wheels / curves.
  const setGrade = (clipId: string, patch: Record<string, unknown>) =>
    run("Grade", () => api.rpc("apply_color", { clipId, ...patch }));
  const applyEffect = (clipId: string, type: string, amount?: number, effectId?: string) =>
    run("Effect", () => api.rpc("apply_effect", { clipId, type, ...(amount !== undefined ? { amount } : {}), ...(effectId ? { effectId } : {}) }));
  const removeEffect = (clipId: string, effectId: string) =>
    run("Remove effect", () => api.rpc("remove_effect", { clipId, effectId }));
  const inspectColor = () =>
    run("Inspecting color (scopes)", async () => {
      const at = store.get().playhead;
      const r = await api.rpc<ColorInspection>("inspect_color", { atSeconds: at });
      setScopes(r);
    });
  const clearEffects = (clipId: string) => run("Clear effects", () => api.rpc("clear_clip_effects", { clipId }));
  const setTransition = (clipId: string, type: string, duration: number) =>
    run("Transition", () => api.rpc("set_transition", { clipId, type, durationFrames: Math.max(1, Math.round(duration * fps)) }));
  const removeTransition = (clipId: string) => run("Transition", () => api.rpc("remove_transition", { clipId }));
  const setMusicAsset = (assetId: string) => run("Music", () => api.rpc("set_music", { assetId }));
  const updateMusic = (patch: Record<string, unknown>) =>
    run("Music", () => api.rpc("set_music", { assetId: project?.music?.assetId, ...patch }));
  const removeMusic = () => run("Music", () => api.rpc("remove_music"));
  const addText = (clipId: string, text: string, position: string) =>
    run("Add text", () => api.rpc("add_text", { clipId, text, position }));
  const removeText = (clipId: string, overlayId: string) =>
    run("Remove text", () => api.rpc("remove_text", { clipId, overlayId }));
  const setTextStyle = (clipId: string, overlayId: string, patch: Record<string, unknown>) =>
    run("Text style", () => api.rpc("set_text_style", { clipId, overlayId, ...patch }));
  const animateText = (clipId: string, overlayId: string, property: string, keyframes: { frame: number; value: number; ease?: string }[]) =>
    run("Animate text", () => api.rpc("animate_text", { clipId, overlayId, property, keyframes }));
  const generateCaptions = (clipId: string, model: string) =>
    run("Transcribing (Whisper)", () => api.rpc("generate_captions", { clipId, model }));
  const clearCaptions = (clipId: string) => run("Clear captions", () => api.rpc("clear_captions", { clipId }));
  const setCaptionStyle = (clipId: string, patch: Record<string, unknown>) =>
    run("Caption style", () => api.rpc("set_caption_style", { clipId, ...patch }));
  const autoReframe = (clipId: string) =>
    run("Auto-reframing (tracking subject)", () => api.rpc("auto_reframe", { clipId }));
  const setAudioOffset = (clipId: string, offset: number) =>
    run("Audio offset (J/L cut)", () => api.rpc("set_audio_offset", { clipId, offsetFrames: Math.round(offset * fps) }));
  const setTransform = (clipId: string, patch: Record<string, number | boolean>) =>
    run("Transform", () => api.rpc("set_clip_transform", { clipId, ...patch }));
  // Move/resize a timeline element (text overlay / motion graphic / caption cue)
  // from the timeline element-rail drag → the matching window RPC.
  const setElementWindow = (
    kind: "text" | "graphic" | "caption",
    clipId: string,
    ref: string | number,
    startFrame: number,
    endFrame: number,
  ) => {
    const call =
      kind === "text"
        ? api.rpc("set_text_window", { clipId, overlayId: ref, startFrame, endFrame })
        : kind === "graphic"
          ? api.rpc("set_graphic_window", { clipId, graphicId: ref, startFrame, endFrame })
          : api.rpc("set_caption_cue", { clipId, index: ref, startFrame, endFrame });
    return run("Adjust element", () => call);
  };
  // Add/replace a keyframe for a property at the current playhead (clip-local).
  const addKeyframe = (clipId: string, property: KeyframeProperty, value: number) =>
    run("Keyframe", () => {
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return Promise.resolve();
      const frame = Math.max(0, Math.round(store.get().playhead * fps) - clip.startFrame);
      const others = (clip.keyframes?.[property] ?? []).filter((k) => k.frame !== frame);
      const next = [...others, { frame, value }].sort((a, b) => a.frame - b.frame);
      return api.rpc("set_keyframes", { clipId, property, keyframes: next });
    });
  const clearKeyframes = (clipId: string, property?: KeyframeProperty) =>
    run("Clear keyframes", () => api.rpc("clear_keyframes", { clipId, ...(property ? { property } : {}) }));

  const seek = useCallback((t: number) => playerRef.current?.seek(t), []);

  // Keyboard transport + editor shortcuts. Transport keys use the stable
  // playerRef; editing keys (split/delete/undo) read live state, so the effect
  // re-subscribes when the selection or clip list changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      // ----- edit shortcuts -----
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (mod) return; // leave other Ctrl/Cmd combos to the OS/browser
      if ((e.key === "s" || e.key === "S") && selectedClip) {
        e.preventDefault();
        const clip = clips.find((c) => c.id === selectedClip);
        if (clip) {
          const local = Math.round(store.get().playhead * fps) - clip.startFrame;
          if (local > 0 && local < clipDurationFrames(clip)) splitClipAt(selectedClip, local);
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedClip) { e.preventDefault(); removeClip(selectedClip); return; }
      // ----- transport -----
      if (e.key === " ") { e.preventDefault(); playerRef.current?.toggle(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); playerRef.current?.step(e.shiftKey ? -10 : -1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); playerRef.current?.step(e.shiftKey ? 10 : 1); }
      else if (e.key === "[") { e.preventDefault(); playerRef.current?.jumpClip(-1); }
      else if (e.key === "]") { e.preventDefault(); playerRef.current?.jumpClip(1); }
      else if (e.key === "Home") { e.preventDefault(); playerRef.current?.seek(0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedClip, clips, fps, store, undo, redo, splitClipAt, removeClip]);

  const selected = clips.find((c) => c.id === selectedClip) ?? null;
  const selectedIndex = clips.findIndex((c) => c.id === selectedClip);
  const audioAssets = project?.assets.filter((a) => a.hasAudio) ?? [];
  const music = project?.music;
  const musicAsset = music ? assetById.get(music.assetId) : undefined;

  return (
    <div className="editor">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><img src={reloLogo} alt="" className="brand-logo" /></span>
          <span className="brand-name">SynthCut<span className="brand-by">by Relo</span></span>
        </div>
        <div className="transport">
          <button className="icon-btn" onClick={undo} disabled={!connected} aria-label="Undo" title="Undo"><Undo /></button>
          <button className="icon-btn" onClick={redo} disabled={!connected} aria-label="Redo" title="Redo"><Redo /></button>
        </div>
        <div className="proj-bar">
          <div className="proj-ctl">
            <button className="btn btn-sm" onClick={() => setShowProjectMenu((v) => !v)} disabled={!connected} aria-haspopup="menu" aria-expanded={showProjectMenu} title="Project — New / Open / Save">
              <Film size={14} /> Project
            </button>
            {showProjectMenu && (
              <>
                <div className="menu-scrim" onClick={() => setShowProjectMenu(false)} />
                <div className="proj-menu" role="menu">
                  <button role="menuitem" className="proj-menu-item" onClick={newProject}><Plus size={13} /> New project</button>
                  <button role="menuitem" className="proj-menu-item" onClick={openProject}><Import size={13} /> Open…</button>
                  <button role="menuitem" className="proj-menu-item" onClick={saveProject}><Check size={13} /> Save<span className="menu-kbd">Ctrl+S</span></button>
                  <button role="menuitem" className="proj-menu-item" onClick={saveProjectAs}><Export size={13} /> Save As…</button>
                  {recents.length > 0 && (
                    <>
                      <div className="proj-menu-head">Recent</div>
                      {recents.map((p) => (
                        <button key={p} role="menuitem" className="proj-menu-item recent" title={p} onClick={() => openProjectPath(p)}>{baseName(p)}</button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <span className="proj-name" title={projectPath ?? "Unsaved — use Save to create a .aive file"}>
            {project?.name || "Untitled"}
            {dirty && <span className="proj-dot" title="Unsaved changes" aria-label="Unsaved changes">●</span>}
          </span>
        </div>
        <div className="topbar-right">
          <StatusPill connected={connected} port={api.port} />
          <button className="btn" onClick={() => setShowConnect((v) => !v)}>
            <Bot /> Connect AI
          </button>
        </div>
      </header>

      {error && <ErrorBar message={error} onDismiss={() => setError(null)} />}

      {showConnect && (
        <>
          <div className="scrim" onClick={() => setShowConnect(false)} />
          <ConnectPanel onClose={() => setShowConnect(false)} />
        </>
      )}


      {exactSrc && (
        <>
          <div className="scrim" onClick={() => setExactSrc(null)} />
          <div className="exact-modal" role="dialog" aria-label="Exact composite preview">
            <div className="exact-head">
              <span><Film size={15} /> Exact composite <span className="muted">— fully rendered with transitions, color, captions burned in</span></span>
              <button className="icon-btn" onClick={() => setExactSrc(null)} aria-label="Close"><X /></button>
            </div>
            <video src={exactSrc} controls autoPlay />
          </div>
        </>
      )}

      {scopes && (
        <>
          <div className="scrim" onClick={() => setScopes(null)} />
          <div className="exact-modal scopes-modal" role="dialog" aria-label="Color scopes">
            <div className="exact-head">
              <span><Frame size={15} /> Color scopes <span className="muted">— measured at the playhead</span></span>
              <button className="icon-btn" onClick={() => setScopes(null)} aria-label="Close"><X /></button>
            </div>
            <div className="scopes-body">
              <div className="scopes-grid">
                {([["Histogram", scopes.scopes.histogram], ["Waveform", scopes.scopes.waveform], ["Vectorscope", scopes.scopes.vectorscope]] as const).map(
                  ([name, path]) => (
                    <figure className="scope-fig" key={name}>
                      <img src={`${api.fileUrl(path)}&v=${Date.now()}`} alt={`${name} scope`} />
                      <figcaption>{name}</figcaption>
                    </figure>
                  ),
                )}
              </div>
              <div className="scopes-stats">
                <div className="stat-row"><span>Luma</span><b>{scopes.stats.luma.avg.toFixed(0)}</b><span className="muted">min {scopes.stats.luma.min.toFixed(0)} · max {scopes.stats.luma.max.toFixed(0)} · contrast {scopes.stats.luma.contrast.toFixed(0)}</span></div>
                <div className="stat-row"><span>Saturation</span><b>{scopes.stats.saturation.avg.toFixed(0)}</b><span className="muted">peak {scopes.stats.saturation.max.toFixed(0)}</span></div>
                <div className="stat-row"><span>Mean RGB</span><b>{scopes.stats.rgb.r.toFixed(0)} · {scopes.stats.rgb.g.toFixed(0)} · {scopes.stats.rgb.b.toFixed(0)}</b>
                  <span className="rgb-swatch" style={{ background: `rgb(${scopes.stats.rgb.r},${scopes.stats.rgb.g},${scopes.stats.rgb.b})` }} /></div>
                <ul className="scope-notes">{scopes.stats.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="workspace">
        {/* Library */}
        <aside className="panel library">
          <div className="panel-head">
            <span className="panel-title">Library</span>
            {project?.assets.length ? (
              <span className="count-badge">{project.assets.length}</span>
            ) : null}
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={importMedia} disabled={!connected}>
              <Import size={14} /> Import
            </button>
          </div>
          {project?.assets.length ? (
            <div className="lib-search">
              <div className="search-mode" role="group" aria-label="Search type">
                <button className={`sm-btn ${searchMode === "words" ? "on" : ""}`} onClick={() => setSearchMode("words")} title="Search spoken words (transcripts)">Words</button>
                <button className={`sm-btn ${searchMode === "visuals" ? "on" : ""}`} onClick={() => setSearchMode("visuals")} title="Search shots by meaning (semantic)">Visuals</button>
              </div>
              <input
                type="text" placeholder={searchMode === "visuals" ? "Describe a shot… (e.g. sunset)" : "Search spoken words…"} value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                aria-label={searchMode === "visuals" ? "Search shots semantically" : "Search transcripts"}
              />
              {(searchHits || visualHits) ? (
                <button className="icon-btn" aria-label="Clear results" onClick={() => { setSearchHits(null); setVisualHits(null); setQuery(""); }}><X size={13} /></button>
              ) : (
                <button className="icon-btn" aria-label="Search" onClick={runSearch} disabled={!connected}><Search size={13} /></button>
              )}
            </div>
          ) : null}
          {project?.assets.length ? (
            <div className="folder-chips" role="group" aria-label="Filter by folder">
              <button className={`chip ${folderFilter === null ? "on" : ""}`} onClick={() => setFolderFilter(null)}>All</button>
              {folders.map((f) => (
                renamingFolder === f.id ? (
                  <input
                    key={f.id} className="chip-folder-input" autoFocus defaultValue={f.name}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { renameFolder(f.id, (e.target as HTMLInputElement).value); setRenamingFolder(null); }
                      else if (e.key === "Escape") setRenamingFolder(null);
                    }}
                    onBlur={(e) => { renameFolder(f.id, e.target.value); setRenamingFolder(null); }}
                  />
                ) : (
                  <span key={f.id} className={`chip chip-folder ${folderFilter === f.id ? "on" : ""}`}>
                    <button className="chip-folder-name" onClick={() => setFolderFilter(f.id)} onDoubleClick={() => setRenamingFolder(f.id)} title={`${f.name} — double-click to rename`}>{f.name}</button>
                    <button className="chip-folder-x" onClick={() => deleteFolder(f.id)} title="Delete folder (assets are kept)" aria-label="Delete folder"><X size={11} /></button>
                  </span>
                )
              ))}
              {addingFolder ? (
                <input
                  className="chip-folder-input" autoFocus value={folderName}
                  placeholder="Folder name…"
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitFolder();
                    else if (e.key === "Escape") { setFolderName(""); setAddingFolder(false); }
                  }}
                  onBlur={() => { if (!folderName.trim()) setAddingFolder(false); }}
                />
              ) : (
                <button className="chip chip-add" onClick={() => setAddingFolder(true)} disabled={!connected} title="New folder"><FolderPlus size={12} /></button>
              )}
            </div>
          ) : null}
          <div className="panel-body">
            {searchHits ? (
              <div className="search-results">
                <div className="results-head">{searchHits.length} spoken-word {searchHits.length === 1 ? "hit" : "hits"}</div>
                {searchHits.map((h, i) => (
                  <button key={i} className="result-row" onClick={() => seek(h.start)} title="Seek preview to this moment">
                    <span className="result-time">{fmt(h.start)}</span>
                    <span className="result-text">{h.text}</span>
                    <span className="result-src">{h.assetName}</span>
                  </button>
                ))}
                {searchHits.length === 0 && <div className="empty-text pad">No matches. Index an asset's transcript first (the ◎ button on a card).</div>}
              </div>
            ) : visualHits ? (
              <div className="search-results">
                <div className="results-head">Similar to <b>{visualHits.refName}</b> {visualHits.semantic ? "(semantic)" : "(perceptual)"}</div>
                {visualHits.hits.map((h) => (
                  <div key={h.assetId} className="result-row vis">
                    <div className="asset-thumb sm">{thumbs[h.assetId] ? <img src={thumbs[h.assetId]} alt="" /> : <Film size={14} />}</div>
                    <span className="result-text">{h.name}</span>
                    <span className="result-score">{Math.round(h.score * 100)}%</span>
                    <button className="icon-btn" onClick={() => addToTimeline(h.assetId)} aria-label="Add to timeline"><Plus size={14} /></button>
                  </div>
                ))}
                {visualHits.hits.length === 0 && <div className="empty-text pad">No other shots indexed yet.</div>}
              </div>
            ) : visibleAssets.length ? (
              <div className="asset-list">
                {visibleAssets.map((a) => (
                  <div key={a.id} className="asset-card">
                    <div className="asset-thumb">
                      {thumbs[a.id] ? (
                        <img src={thumbs[a.id]} alt="" />
                      ) : a.hasVideo ? (
                        <Film size={18} />
                      ) : (
                        <Waveform size={18} />
                      )}
                    </div>
                    <div className="asset-info">
                      <div className="asset-name" title={a.path}>{a.name}</div>
                      <div className="asset-meta">
                        {a.hasVideo && (
                          <>
                            <span>{a.width}×{a.height}</span>
                            <span className="sep">·</span>
                          </>
                        )}
                        <span>{fmt(a.duration)}</span>
                        {(a.transcriptIndexed || a.transcript) && <><span className="sep">·</span><span title="Transcript indexed">◎</span></>}
                        {a.proxyPath && <><span className="sep">·</span><span title="Preview proxy ready (export uses full res)">⚡</span></>}
                        {a.hasAudio && (
                          <>
                            <span className="sep">·</span>
                            <Waveform size={11} />
                          </>
                        )}
                      </div>
                      {folders.length > 0 && (
                        <select className="folder-pick" value={a.folderId ?? ""} onChange={(e) => moveToFolder(a.id, e.target.value || null)} aria-label="Folder">
                          <option value="">No folder</option>
                          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                      )}
                    </div>
                    <div className="asset-actions">
                      <button className="icon-btn" onClick={() => addToTimeline(a.id)} aria-label="Add to timeline" title="Add to timeline">
                        <Plus size={15} />
                      </button>
                      <button className="icon-btn" onClick={() => indexAsset(a.id, { transcript: true, visual: true })} aria-label="Index for search" title="Index transcript + visuals for search" disabled={!connected}>
                        <Search size={14} />
                      </button>
                      {a.hasVideo && (
                        <button className="icon-btn" onClick={() => findSimilar(a.id, a.name)} aria-label="Find similar shots" title="Find similar-looking shots" disabled={!connected}>
                          <Sparkles size={14} />
                        </button>
                      )}
                      <button className="icon-btn" onClick={() => removeAsset(a.id)} aria-label="Remove from library" title="Remove">
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <span className="empty-icon"><Import size={20} /></span>
                <span className="empty-title">{project?.assets.length ? "Empty folder" : "No media yet"}</span>
                <span className="empty-text">{project?.assets.length ? "No assets in this folder." : "Click Import to add footage, or ask your AI client to import it for you."}</span>
              </div>
            )}
          </div>
        </aside>

        {/* Stage / preview */}
        <main className="stage">
          <div className="stage-bar">
            <div className="seg" role="group" aria-label="Aspect ratio">
              {ASPECT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`seg-btn ${project && project.width === p.width && project.height === p.height ? "active" : ""}`}
                  onClick={() => setAspect(p.width, p.height)}
                  disabled={!connected}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="proj-chip">
              {project && (
                <>
                  <Frame size={13} />
                  {project.width}×{project.height}
                  <span className="sep">·</span>{project.fps}fps
                  <span className="sep">·</span>{fmt(totalDuration)}
                </>
              )}
            </span>
          </div>

          <div className="stage-view">
            <PreviewPlayer
              ref={playerRef}
              segments={segments}
              project={project}
              assetById={assetById}
              music={music}
              musicAsset={musicAsset}
              api={api}
              store={store}
              onSelectClip={setSelectedClip}
            />
          </div>

          <div className="transport-bar">
            <div className="tp-controls">
              <button className="icon-btn" onClick={() => playerRef.current?.jumpClip(-1)} disabled={!segments.length} aria-label="Previous clip" title="Previous clip ([)"><SkipStart /></button>
              <button className="play-btn" onClick={() => playerRef.current?.toggle()} disabled={!segments.length} aria-label={playing ? "Pause" : "Play"} title="Play / Pause (Space)">
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="icon-btn" onClick={() => playerRef.current?.jumpClip(1)} disabled={!segments.length} aria-label="Next clip" title="Next clip (])"><SkipEnd /></button>
            </div>
            <TransportClock store={store} />
            <span className="tp-spacer" />
            <button className="btn btn-sm" onClick={renderExact} disabled={!connected || segments.length === 0} title="Render the exact composited frame-accurate preview">
              <Sparkles size={14} /> Render exact
            </button>
            <div className="export-ctl">
              <button className="btn btn-sm" onClick={() => setShowExport((v) => !v)} disabled={!connected || segments.length === 0} aria-haspopup="menu" aria-expanded={showExport}>
                <Export size={15} /> Export…
              </button>
              {showExport && (
                <>
                  <div className="menu-scrim" onClick={() => setShowExport(false)} />
                  <div className="export-menu" role="menu">
                    <div className="export-menu-head">Export preset</div>
                    {EXPORT_PRESETS.map((p) => (
                      <button key={p.id} role="menuitem" className="export-menu-item" onClick={() => exportVideo(p.id)}>
                        <span className="exp-name">{p.label}</span>
                        <span className="exp-desc">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="music-ctl">
              <Music size={15} />
              {audioAssets.length === 0 ? (
                <span className="muted">Import audio for music</span>
              ) : (
                <>
                  <select
                    value={music?.assetId ?? ""}
                    onChange={(e) => (e.target.value ? setMusicAsset(e.target.value) : removeMusic())}
                    disabled={!connected}
                    aria-label="Background music"
                  >
                    <option value="">No music</option>
                    {audioAssets.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {music && (
                    <>
                      <input
                        type="number" step="0.05" min="0" max="4" aria-label="Music volume"
                        defaultValue={music.volume}
                        key={`mvol-${music.assetId}-${music.volume}`}
                        onBlur={(e) => updateMusic({ volume: Number(e.target.value), duck: music.duck })}
                      />
                      <label className="duck">
                        <input
                          type="checkbox" checked={music.duck ?? false}
                          onChange={(e) => updateMusic({ volume: music.volume, duck: e.target.checked })}
                        />
                        Duck
                      </label>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </main>

        {/* Inspector */}
        <aside className="panel inspector">
          {selected ? (
            <ClipInspector
              key={selected.id}
              clip={selected}
              index={selectedIndex}
              asset={selected.assetId ? assetById.get(selected.assetId) : undefined}
              thumb={selected.assetId ? thumbs[selected.assetId] : undefined}
              project={project}
              connected={connected}
              busy={!!busy}
              onTrim={trimClip}
              onSpeed={setSpeed}
              onVolume={setVolume}
              onFade={setFade}
              onColor={setColor}
              onGrade={setGrade}
              onApplyEffect={applyEffect}
              onRemoveEffect={removeEffect}
              onInspectColor={inspectColor}
              onClearEffects={clearEffects}
              onTransition={setTransition}
              onRemoveTransition={removeTransition}
              onAutoReframe={autoReframe}
              onAudioOffset={setAudioOffset}
              onTransform={setTransform}
              onAddKeyframe={addKeyframe}
              onClearKeyframes={clearKeyframes}
              onAddText={addText}
              onRemoveText={removeText}
              onSetTextStyle={setTextStyle}
              onAnimateText={animateText}
              onGenerateCaptions={generateCaptions}
              onClearCaptions={clearCaptions}
              onCaptionStyle={setCaptionStyle}
            />
          ) : (
            <ProjectInspector
              project={project}
              clipCount={clips.length}
              totalDuration={totalDuration}
              connected={connected}
              onImport={importMedia}
            />
          )}
        </aside>
      </div>

      {/* Timeline */}
      <Timeline
        project={project}
        assetById={assetById}
        thumbs={thumbs}
        store={store}
        selectedClip={selectedClip}
        justUpdated={justUpdated}
        connected={connected}
        music={music}
        musicAsset={musicAsset}
        onSelectClip={setSelectedClip}
        onSeek={seek}
        onSplit={splitClipAt}
        onMoveClip={moveClipTo}
        onTrimClip={trimClipEdge}
        onRemove={removeClip}
        onRippleDelete={rippleDelete}
        onSetTrack={setTrackProps}
        onAddTrack={addTrack}
        onRemoveTrack={removeTrack}
        onSetElementWindow={setElementWindow}
        onSetMarkers={setMarkers}
      />

      <footer className="statusbar">
        {progress ? (
          <div className="prog">
            <span className="label"><span className="spinner" /> {progress.job === "export" ? "Exporting" : "Rendering"}…</span>
            <div className="prog-bar"><div className="prog-fill" style={{ "--p": progress.fraction } as CSSProperties} /></div>
            <span className="pct">{Math.round(progress.fraction * 100)}%</span>
          </div>
        ) : busy ? (
          <span className="ready"><span className="spinner" /> {busy}…</span>
        ) : (
          <span className="ready">{connected ? "Ready — press Space to play · drive edits from your AI client or the controls above." : "Waiting for the editor core to connect…"}</span>
        )}
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function TransportClock({ store }: { store: ReturnType<typeof createPlaybackStore> }) {
  const ph = usePlaybackValue(store, (s) => s.playhead);
  const dur = usePlaybackValue(store, (s) => s.duration);
  return (
    <span className="tp-clock">
      <span className="tp-now">{fmtTime(ph, true)}</span>
      <span className="tp-sep">/</span>
      <span className="tp-dur">{fmtTime(dur, true)}</span>
    </span>
  );
}

function StatusPill({ connected, port }: { connected: boolean; port: number }) {
  return connected ? (
    <span className="statuspill ok" title={`Connected to core on port ${port}`}>
      <span className="dot" /><Check size={13} /> Core <span className="port">:{port}</span>
    </span>
  ) : (
    <span className="statuspill bad" title="Not connected to the editor core">
      <span className="dot" /><Alert size={13} /> Offline
    </span>
  );
}

function ErrorBar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-bar" role="alert" onClick={onDismiss}>
      <Alert size={16} />
      <span className="msg">{message}</span>
      <span className="dismiss">dismiss</span>
    </div>
  );
}

// ---- Phase 5: color grade + effects UI vocabulary --------------------------
const WHEEL_LABELS = { lift: "Lift · shadows", gamma: "Gamma · mids", gain: "Gain · highlights" } as const;

const CURVE_PRESETS: Record<string, string> = {
  None: "",
  "S-curve (contrast)": "0/0 0.25/0.18 0.75/0.85 1/1",
  "Lifted blacks": "0/0.06 0.5/0.5 1/0.96",
  "Crush (punchy)": "0/0 0.2/0.1 0.8/0.92 1/1",
  "Fade (matte)": "0/0.1 1/0.92",
};
function matchCurve(curve?: string): string {
  const c = (curve ?? "").trim().replace(/\s+/g, " ");
  if (!c) return "None";
  for (const [k, v] of Object.entries(CURVE_PRESETS)) if (v && v === c) return k;
  return "Custom";
}

// Effect amount ranges [min,max,step]; absent = the effect takes no amount.
const EFFECT_RANGE: Record<string, [number, number, number]> = {
  blur: [0, 50, 1],
  sharpen: [0, 5, 0.1],
  detail: [0, 1, 0.05],
  denoise: [0, 30, 1],
  vignette: [0, 1.5, 0.05],
  posterize: [2, 32, 1],
  pixelate: [2, 64, 1],
};
const EFFECT_DEFAULT_AMOUNT: Record<string, number | undefined> = {
  blur: 8, sharpen: 1, detail: 0.5, denoise: 4, posterize: 6, pixelate: 16,
};
const EFFECT_TYPE_NAMES = [
  "blur", "sharpen", "detail", "denoise", "sepia", "grayscale",
  "vignette", "edges", "posterize", "pixelate", "chromakey",
];

/** A compact 3-channel (R/G/B) color-wheel control as three mini sliders. */
function WheelRow({ label, wheel, onChange }: {
  label: string; wheel: { r?: number; g?: number; b?: number };
  onChange: (channel: "r" | "g" | "b", value: number) => void;
}) {
  // Track value locally while dragging; only commit (→ RPC) on release.
  const [local, setLocal] = useState<{ r?: number; g?: number; b?: number }>(wheel);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setLocal(wheel); }, [wheel]);
  return (
    <div className="wheel-row">
      <span className="wheel-label">{label}</span>
      <div className="wheel-chans">
        {(["r", "g", "b"] as const).map((ch) => (
          <label key={ch} className={`wheel-chan wheel-${ch}`}>
            <span>{ch.toUpperCase()}</span>
            <input type="range" min={-1} max={1} step={0.02} value={local[ch] ?? 0}
              aria-label={`${label} ${ch.toUpperCase()}`}
              onChange={(e) => { dragging.current = true; setLocal((s) => ({ ...s, [ch]: Number(e.target.value) })); }}
              onPointerUp={(e) => { dragging.current = false; onChange(ch, Number((e.target as HTMLInputElement).value)); }}
              onKeyUp={(e) => { dragging.current = false; onChange(ch, Number((e.target as HTMLInputElement).value)); }}
              onPointerCancel={() => { dragging.current = false; }} />
          </label>
        ))}
      </div>
    </div>
  );
}

function RangeField({
  label, value, min, max, step, def, unit = "", onCommit,
}: {
  label: string; value: number; min: number; max: number; step: number; def: number; unit?: string;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setV(value); }, [value]);
  const pct = max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0;
  const reset = () => { dragging.current = false; setV(def); onCommit(def); };
  return (
    <div className="rfield">
      <div className="rfield-top">
        <label>{label}</label>
        <span className="rval">
          {fmtNum(v)}{unit}
          {Math.abs(v - def) > 1e-9 && (
            <button type="button" className="reset-btn" onClick={reset} aria-label={`Reset ${label}`} title="Reset"><RotateCcw size={12} /></button>
          )}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={v} aria-label={label}
        style={{ "--range-fill": `${pct}%` } as CSSProperties}
        onChange={(e) => { dragging.current = true; setV(Number(e.target.value)); }}
        onPointerUp={() => { dragging.current = false; onCommit(v); }}
        onPointerCancel={() => { dragging.current = false; }}
        onKeyUp={() => { dragging.current = false; onCommit(v); }}
        onBlur={() => { dragging.current = false; }}
      />
    </div>
  );
}

// A RangeField plus a ◆ keyframe button: ◆ pins the current value at the
// playhead; the badge shows how many keyframes exist and clears them on click.
function AnimRow(props: {
  label: string; unit?: string; min: number; max: number; step: number; def: number;
  value: number; keyCount: number;
  onCommit: (v: number) => void; onKey: () => void; onClear: () => void;
}) {
  return (
    <div className="anim-row">
      <RangeField
        label={props.label} unit={props.unit} min={props.min} max={props.max}
        step={props.step} def={props.def} value={props.value} onCommit={props.onCommit}
      />
      <div className="anim-kf">
        <button
          type="button"
          className={`kf-btn ${props.keyCount > 0 ? "keyed" : ""}`}
          onClick={props.onKey}
          aria-label={`Add ${props.label} keyframe at playhead`}
          title={`Add a ${props.label} keyframe at the playhead`}
        >
          ◆
        </button>
        {props.keyCount > 0 && (
          <button
            type="button"
            className="kf-count"
            onClick={props.onClear}
            aria-label={`Clear ${props.label} keyframes`}
            title={`Clear ${props.keyCount} ${props.label} keyframe${props.keyCount === 1 ? "" : "s"}`}
          >
            {props.keyCount}
          </button>
        )}
      </div>
    </div>
  );
}

// Curated font picker. These families resolve in BOTH the live preview (CSS
// font-family) AND the FFmpeg export (the core's system-font lookup), so the
// preview matches the burned-in result. `font` stays open in the core, so the
// "Custom…" escape still accepts any installed family name or a .ttf/.otf path
// (e.g. a downloaded Google Font). Value "" = the renderer default.
const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "Impact — bold display", value: "Impact" },
  { label: "Bahnschrift — modern", value: "Bahnschrift" },
  { label: "Arial", value: "Arial" },
  { label: "Arial Black — heavy", value: "Arial Black" },
  { label: "Segoe UI", value: "Segoe UI" },
  { label: "Verdana — legible", value: "Verdana" },
  { label: "Tahoma", value: "Tahoma" },
  { label: "Trebuchet MS", value: "Trebuchet MS" },
  { label: "Georgia — serif", value: "Georgia" },
  { label: "Times New Roman — serif", value: "Times New Roman" },
  { label: "Courier New — mono", value: "Courier New" },
  { label: "Comic Sans MS", value: "Comic Sans MS" },
  { label: "Calibri", value: "Calibri" },
];
// Popular Google Fonts hinted in the Custom field (must be installed locally to
// render in the export — the core resolves them from the system font folders).
const GOOGLE_FONT_HINTS = ["Inter", "Roboto", "Montserrat", "Poppins", "Oswald", "Bebas Neue", "Lato", "Open Sans", "Anton", "Archivo"];

/** Normalize a stored FFmpeg color (may carry @alpha or an 8-digit hex) to the
 *  7-char #rrggbb a native <input type=color> needs. */
function hex6(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const m = /^#?([0-9a-fA-F]{6})/.exec(c.replace(/^0x/i, ""));
  return m ? `#${m[1]}` : fallback;
}

/**
 * Shared open-vocabulary text styling editor — drives position, font, size,
 * color, outline, drop shadow and background box for BOTH text overlays
 * (set_text_style) and captions (set_caption_style). `onChange` receives only
 * the field(s) that changed; the parent maps it to the right RPC.
 */
function TextStyleEditor({ style, onChange }: {
  style: TextStyle;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const shadowOn = (style.shadowX ?? 0) !== 0 || (style.shadowY ?? 0) !== 0;
  const font = style.font ?? "";
  const matched = FONT_CHOICES.find((c) => c.value.toLowerCase() === font.toLowerCase());
  // "Custom" when a font is set that isn't a preset (e.g. an installed Google
  // Font name or a .ttf path) — show the free-text field for it.
  const [customFont, setCustomFont] = useState(!!font && !matched);
  return (
    <div className="style-editor">
      <div className="dual">
        <div className="field">
          <label>Position</label>
          <select value={style.position ?? "bottom"} onChange={(e) => onChange({ position: e.target.value })}>
            {TEXT_POSITIONS.map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </div>
        <div className="field">
          <label>Size (px)</label>
          <input
            type="number" min="10" max="400" step="1"
            defaultValue={style.fontSize ?? 42} key={`fs-${style.fontSize ?? 42}`}
            onBlur={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="field">
        <label>Font</label>
        <select
          value={customFont ? "__custom__" : (matched?.value ?? "")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") { setCustomFont(true); return; }
            setCustomFont(false);
            onChange({ font: v });
          }}
        >
          {FONT_CHOICES.map((c) => <option key={c.label} value={c.value}>{c.label}</option>)}
          <option value="__custom__">Custom… (any installed font / path)</option>
        </select>
        {customFont && (
          <input
            type="text" list="font-suggestions" placeholder="Font name or .ttf/.otf path (e.g. Montserrat)"
            defaultValue={font} key={`font-${font}`}
            onBlur={(e) => onChange({ font: e.target.value.trim() })}
          />
        )}
        <datalist id="font-suggestions">{GOOGLE_FONT_HINTS.map((f) => <option key={f} value={f} />)}</datalist>
      </div>
      <div className="swatch-row">
        <label className="swatch"><input type="color" value={hex6(style.color, "#ffffff")} onChange={(e) => onChange({ color: e.target.value })} aria-label="Text color" />Text</label>
        <label className="swatch"><input type="color" value={hex6(style.outlineColor, "#000000")} onChange={(e) => onChange({ outlineColor: e.target.value })} aria-label="Outline color" />Outline</label>
        <div className="field thin">
          <label>Outline w.</label>
          <input type="number" min="0" max="40" step="0.5" defaultValue={style.outlineWidth ?? 0} key={`ow-${style.outlineWidth ?? 0}`}
            onBlur={(e) => onChange({ outlineWidth: Number(e.target.value) })} />
        </div>
      </div>
      <div className="swatch-row">
        <label className="duck">
          <input type="checkbox" checked={shadowOn}
            onChange={(e) => onChange(e.target.checked ? { shadowColor: hex6(style.shadowColor, "#000000"), shadowX: 2, shadowY: 2 } : { shadowX: 0, shadowY: 0 })} />
          Drop shadow
        </label>
        {shadowOn && (
          <label className="swatch"><input type="color" value={hex6(style.shadowColor, "#000000")} onChange={(e) => onChange({ shadowColor: e.target.value })} aria-label="Shadow color" />Color</label>
        )}
      </div>
      <div className="swatch-row">
        <label className="duck">
          <input type="checkbox" checked={style.box ?? false} onChange={(e) => onChange({ box: e.target.checked })} />
          Background box
        </label>
        {style.box && (
          <label className="swatch"><input type="color" value={hex6(style.boxColor, "#000000")} onChange={(e) => onChange({ boxColor: e.target.value })} aria-label="Box color" />Box</label>
        )}
      </div>
    </div>
  );
}

type InspectorProps = {
  clip: Clip;
  index: number;
  asset?: MediaAsset;
  thumb?: string;
  project: Project | null;
  connected: boolean;
  busy: boolean;
  onTrim: (clipId: string, field: "sourceIn" | "sourceOut", value: number) => void;
  onSpeed: (clipId: string, v: number) => void;
  onVolume: (clipId: string, v: number) => void;
  onFade: (clipId: string, fadeIn: number, fadeOut: number) => void;
  onColor: (clipId: string, patch: Record<string, number>) => void;
  onGrade: (clipId: string, patch: Record<string, unknown>) => void;
  onApplyEffect: (clipId: string, type: string, amount?: number, effectId?: string) => void;
  onRemoveEffect: (clipId: string, effectId: string) => void;
  onInspectColor: () => void;
  onClearEffects: (clipId: string) => void;
  onTransition: (clipId: string, type: string, duration: number) => void;
  onRemoveTransition: (clipId: string) => void;
  onAutoReframe: (clipId: string) => void;
  onAudioOffset: (clipId: string, offset: number) => void;
  onTransform: (clipId: string, patch: Record<string, number | boolean>) => void;
  onAddKeyframe: (clipId: string, property: KeyframeProperty, value: number) => void;
  onClearKeyframes: (clipId: string, property?: KeyframeProperty) => void;
  onAddText: (clipId: string, text: string, position: string) => void;
  onAnimateText: (clipId: string, overlayId: string, property: string, keyframes: { frame: number; value: number; ease?: string }[]) => void;
  onRemoveText: (clipId: string, overlayId: string) => void;
  onSetTextStyle: (clipId: string, overlayId: string, patch: Record<string, unknown>) => void;
  onGenerateCaptions: (clipId: string, model: string) => void;
  onClearCaptions: (clipId: string) => void;
  onCaptionStyle: (clipId: string, patch: Record<string, unknown>) => void;
};

type Tab = "adjust" | "text" | "captions";

function ClipInspector(props: InspectorProps) {
  const { clip, index, asset, thumb, project, connected, busy } = props;
  const [tab, setTab] = useState<Tab>("adjust");
  const [newText, setNewText] = useState("");
  const [newPos, setNewPos] = useState("bottom");
  const [capModel, setCapModel] = useState("base.en");
  const [styleOpen, setStyleOpen] = useState<string | null>(null);

  const fps = project?.fps ?? 30;
  const dur = clipDurationFrames(clip) / fps;
  const fx = clip.effects ?? {};
  const tf = fx.transform ?? {};
  const grade = fx.grade ?? {};
  const filters = fx.filters ?? [];
  const kfCount = (p: KeyframeProperty) => clip.keyframes?.[p]?.length ?? 0;
  const overlays = clip.overlays ?? [];
  const cues = clip.captions?.cues ?? [];
  const capStyle = clip.captions?.style ?? {};
  const hasEffects =
    fx.speed !== undefined || fx.volume !== undefined || fx.fadeInFrames || fx.fadeOutFrames ||
    fx.color || fx.grade || (fx.filters?.length ?? 0) > 0 || fx.lut;

  const tabs: { id: Tab; label: string; icon: JSX.Element; count?: number }[] = [
    { id: "adjust", label: "Adjust", icon: <Sliders size={14} /> },
    { id: "text", label: "Text", icon: <Type size={14} />, count: overlays.length },
    { id: "captions", label: "Captions", icon: <Captions size={14} />, count: cues.length },
  ];

  return (
    <>
      <div className="insp-head">
        <div className="insp-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
          {!thumb && (asset?.hasVideo ? <Film size={16} /> : <Waveform size={16} />)}
          <span className="idx">{index + 1}</span>
        </div>
        <div className="insp-titles">
          <div className="insp-name" title={asset?.name}>{asset?.name ?? "Clip"}</div>
          <div className="insp-sub">
            <Clock size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
            {fmt(dur)}{asset?.hasVideo ? ` · ${asset.width}×${asset.height}` : ""}
          </div>
        </div>
      </div>

      <div className="insp-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
            {t.count ? <span className="tab-badge">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="insp-scroll">
        {tab === "adjust" && (
          <>
            <div className="group">
              <div className="group-title"><Scissors size={13} /> Trim</div>
              <div className="dual">
                <div className="field">
                  <label>In (s)</label>
                  <input
                    type="number" step="0.1"
                    defaultValue={(clip.sourceInFrame / fps).toFixed(2)}
                    key={`in-${clip.sourceInFrame}`}
                    onBlur={(e) => props.onTrim(clip.id, "sourceIn", Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Out (s)</label>
                  <input
                    type="number" step="0.1"
                    defaultValue={(clip.sourceOutFrame / fps).toFixed(2)}
                    key={`out-${clip.sourceOutFrame}`}
                    onBlur={(e) => props.onTrim(clip.id, "sourceOut", Number(e.target.value))}
                  />
                </div>
              </div>
              <span className="field-note">Clip length {fmt(dur)}</span>
            </div>

            <div className="group">
              <div className="group-title"><Sliders size={13} /> Speed &amp; audio</div>
              <RangeField label="Speed" unit="×" min={0.25} max={4} step={0.25} def={1}
                value={fx.speed ?? 1} onCommit={(v) => props.onSpeed(clip.id, v)} />
              <AnimRow label="Volume" min={0} max={4} step={0.05} def={1}
                value={fx.volume ?? 1} keyCount={kfCount("volume")}
                onCommit={(v) => props.onVolume(clip.id, v)}
                onKey={() => props.onAddKeyframe(clip.id, "volume", fx.volume ?? 1)}
                onClear={() => props.onClearKeyframes(clip.id, "volume")} />
            </div>

            <div className="group">
              <div className="group-title"><Sliders size={13} /> Transform &amp; animation</div>
              <AnimRow label="Scale" unit="×" min={0.05} max={4} step={0.05} def={1}
                value={tf.scale ?? 1} keyCount={kfCount("scale")}
                onCommit={(v) => props.onTransform(clip.id, { scale: v })}
                onKey={() => props.onAddKeyframe(clip.id, "scale", tf.scale ?? 1)}
                onClear={() => props.onClearKeyframes(clip.id, "scale")} />
              <AnimRow label="Position X" min={-1} max={1} step={0.01} def={0}
                value={tf.x ?? 0} keyCount={kfCount("x")}
                onCommit={(v) => props.onTransform(clip.id, { x: v })}
                onKey={() => props.onAddKeyframe(clip.id, "x", tf.x ?? 0)}
                onClear={() => props.onClearKeyframes(clip.id, "x")} />
              <AnimRow label="Position Y" min={-1} max={1} step={0.01} def={0}
                value={tf.y ?? 0} keyCount={kfCount("y")}
                onCommit={(v) => props.onTransform(clip.id, { y: v })}
                onKey={() => props.onAddKeyframe(clip.id, "y", tf.y ?? 0)}
                onClear={() => props.onClearKeyframes(clip.id, "y")} />
              <AnimRow label="Rotation" unit="°" min={-180} max={180} step={1} def={0}
                value={tf.rotation ?? 0} keyCount={kfCount("rotation")}
                onCommit={(v) => props.onTransform(clip.id, { rotation: v })}
                onKey={() => props.onAddKeyframe(clip.id, "rotation", tf.rotation ?? 0)}
                onClear={() => props.onClearKeyframes(clip.id, "rotation")} />
              <AnimRow label="Opacity" min={0} max={1} step={0.02} def={1}
                value={fx.opacity ?? 1} keyCount={kfCount("opacity")}
                onCommit={(v) => props.onTransform(clip.id, { opacity: v })}
                onKey={() => props.onAddKeyframe(clip.id, "opacity", fx.opacity ?? 1)}
                onClear={() => props.onClearKeyframes(clip.id, "opacity")} />
              <div className="flip-row">
                <button type="button" className={`btn btn-sm ${tf.flipH ? "active" : ""}`}
                  onClick={() => props.onTransform(clip.id, { flipH: !tf.flipH })}>Flip H</button>
                <button type="button" className={`btn btn-sm ${tf.flipV ? "active" : ""}`}
                  onClick={() => props.onTransform(clip.id, { flipV: !tf.flipV })}>Flip V</button>
              </div>
              <span className="field-hint">◆ pins a value at the playhead. Key the same control at two different times to animate it (e.g. scale 0.5→1 for a zoom-in).</span>
            </div>

            <div className="group">
              <div className="group-title"><Waveform size={13} /> Fades</div>
              <RangeField label="Fade in" unit="s" min={0} max={5} step={0.1} def={0}
                value={(fx.fadeInFrames ?? 0) / fps} onCommit={(v) => props.onFade(clip.id, v, (fx.fadeOutFrames ?? 0) / fps)} />
              <RangeField label="Fade out" unit="s" min={0} max={5} step={0.1} def={0}
                value={(fx.fadeOutFrames ?? 0) / fps} onCommit={(v) => props.onFade(clip.id, (fx.fadeInFrames ?? 0) / fps, v)} />
            </div>

            <div className="group">
              <div className="group-title">
                <Frame size={13} /> Color
                {hasEffects && (
                  <button className="btn btn-ghost btn-sm reset-all" onClick={() => props.onClearEffects(clip.id)}>
                    Reset all
                  </button>
                )}
              </div>
              <RangeField label="Brightness" min={-1} max={1} step={0.02} def={0}
                value={fx.color?.brightness ?? 0} onCommit={(v) => props.onColor(clip.id, { brightness: v })} />
              <RangeField label="Contrast" min={0} max={3} step={0.05} def={1}
                value={fx.color?.contrast ?? 1} onCommit={(v) => props.onColor(clip.id, { contrast: v })} />
              <RangeField label="Saturation" min={0} max={3} step={0.05} def={1}
                value={fx.color?.saturation ?? 1} onCommit={(v) => props.onColor(clip.id, { saturation: v })} />

              <div className="sub-title">White balance</div>
              <RangeField label="Temperature" min={-1} max={1} step={0.02} def={0}
                value={grade.temperature ?? 0} onCommit={(v) => props.onGrade(clip.id, { temperature: v })} />
              <RangeField label="Tint" min={-1} max={1} step={0.02} def={0}
                value={grade.tint ?? 0} onCommit={(v) => props.onGrade(clip.id, { tint: v })} />
              <RangeField label="Hue" unit="°" min={-180} max={180} step={1} def={0}
                value={grade.hue ?? 0} onCommit={(v) => props.onGrade(clip.id, { hue: v })} />

              <div className="sub-title">Color wheels</div>
              {(["lift", "gamma", "gain"] as const).map((w) => (
                <WheelRow key={w} label={WHEEL_LABELS[w]} wheel={grade[w] ?? {}}
                  onChange={(ch, v) => props.onGrade(clip.id, { [w]: { ...(grade[w] ?? {}), [ch]: v } })} />
              ))}

              <div className="sub-title">Tone curve</div>
              <div className="field">
                <label>Master curve</label>
                <select value={matchCurve(grade.curve)}
                  onChange={(e) => { if (e.target.value !== "Custom") props.onGrade(clip.id, { curve: CURVE_PRESETS[e.target.value] ?? "" }); }}>
                  {matchCurve(grade.curve) === "Custom" && <option value="Custom">Custom (set by AI)</option>}
                  {Object.keys(CURVE_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>

              <button className="btn btn-block" disabled={!connected || busy} onClick={() => props.onInspectColor()}>
                <Frame size={14} /> Inspect color (scopes)
              </button>
              <span className="field-hint">Reads luma/contrast, saturation, hue & color cast at the playhead and shows histogram / waveform / vectorscope.</span>
            </div>

            <div className="group">
              <div className="group-title"><Sliders size={13} /> Effects</div>
              <div className="dual">
                <div className="field">
                  <label>Add effect</label>
                  <select value="" onChange={(e) => { if (e.target.value) props.onApplyEffect(clip.id, e.target.value, EFFECT_DEFAULT_AMOUNT[e.target.value]); }}>
                    <option value="">Choose…</option>
                    {EFFECT_TYPE_NAMES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {filters.length === 0 ? (
                <span className="field-hint">Stack blur, sharpen, vignette, chromakey and more — baked in order after color.</span>
              ) : (
                filters.map((f: VisualEffect) => (
                  <div className="eff-row" key={f.id}>
                    <div className="eff-body">
                      {EFFECT_RANGE[f.type] ? (
                        <RangeField label={f.type} min={EFFECT_RANGE[f.type][0]} max={EFFECT_RANGE[f.type][1]} step={EFFECT_RANGE[f.type][2]}
                          def={EFFECT_DEFAULT_AMOUNT[f.type] ?? 0} value={f.amount ?? EFFECT_DEFAULT_AMOUNT[f.type] ?? 0}
                          onCommit={(v) => props.onApplyEffect(clip.id, f.type, v, f.id)} />
                      ) : (
                        <span className="eff-name">{f.type}</span>
                      )}
                    </div>
                    <button className="icon-btn" aria-label={`Remove ${f.type}`} onClick={() => props.onRemoveEffect(clip.id, f.id)}><X size={13} /></button>
                  </div>
                ))
              )}
            </div>

            <div className="group">
              <div className="group-title"><Crop size={13} /> Reframe</div>
              <button
                className="btn btn-block"
                onClick={() => props.onAutoReframe(clip.id)}
                disabled={!connected || busy || !asset?.hasVideo}
              >
                <Crop size={14} /> Auto-reframe to {project?.width}×{project?.height}
              </button>
              <span className="field-hint">Set the aspect ratio above the preview first (e.g. 9:16), then reframe — local face tracking keeps the subject in frame.</span>
            </div>

            {index > 0 && (
              <div className="group">
                <div className="group-title"><ChevronRight size={13} /> Transition (from previous)</div>
                <div className="dual">
                  <div className="field">
                    <label>Type</label>
                    <select
                      value={clip.transition?.type ?? ""}
                      onChange={(e) =>
                        e.target.value
                          ? props.onTransition(clip.id, e.target.value, clip.transition ? clip.transition.durationFrames / fps : 0.5)
                          : props.onRemoveTransition(clip.id)
                      }
                    >
                      <option value="">Hard cut</option>
                      {TRANSITION_GROUPS.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.types.map((t) => (<option key={t} value={t}>{t}</option>))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Duration (s)</label>
                    <input
                      type="number" step="0.1" min="0.1" disabled={!clip.transition}
                      defaultValue={clip.transition ? (clip.transition.durationFrames / fps).toFixed(2) : 0.5}
                      key={`tr-${clip.transition?.durationFrames ?? 0}`}
                      onBlur={(e) => clip.transition && props.onTransition(clip.id, clip.transition.type, Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="group">
              <div className="group-title"><Waveform size={13} /> Audio sync (J/L cut)</div>
              <RangeField label="Audio offset" unit="s" min={-10} max={10} step={0.1} def={0}
                value={(clip.audioOffsetFrames ?? 0) / fps} onCommit={(v) => props.onAudioOffset(clip.id, v)} />
              <span className="field-hint">− leads (J-cut: hear the next clip before you see it) · + trails (L-cut: this audio runs over the next clip).</span>
            </div>
          </>
        )}

        {tab === "text" && (
          <div className="group">
            <div className="group-title"><Type size={13} /> Text overlays</div>
            {overlays.length > 0 && (
              <div className="overlay-list">
                {overlays.map((o) => {
                  const animated = !!o.keyframes && Object.keys(o.keyframes).length > 0;
                  const f = (s: number) => Math.round(s * fps);
                  return (
                    <div className="overlay-item" key={o.id}>
                      <div className="overlay-top">
                        <span className="overlay-text" title={o.position ?? "bottom"}>{o.text}{animated && <span className="kf-dot" title="Animated">◆</span>}</span>
                        <button className={`btn btn-ghost btn-sm ${styleOpen === o.id ? "active" : ""}`} onClick={() => setStyleOpen(styleOpen === o.id ? null : o.id)} aria-expanded={styleOpen === o.id} title="Position, color & style">
                          <Sliders size={12} /> Style
                        </button>
                        <button className="chip-x" onClick={() => props.onRemoveText(clip.id, o.id)} aria-label="Remove overlay"><X size={12} /></button>
                      </div>
                      {styleOpen === o.id && (
                        <TextStyleEditor style={o} onChange={(patch) => props.onSetTextStyle(clip.id, o.id, patch)} />
                      )}
                      <div className="overlay-anim" role="group" aria-label="Animate title">
                        <span className="anim-label">Animate</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => props.onAnimateText(clip.id, o.id, "opacity", [{ frame: 0, value: 0 }, { frame: f(0.4), value: 1, ease: "easeOut" }])}>Fade in</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { props.onAnimateText(clip.id, o.id, "y", [{ frame: 0, value: 0.96 }, { frame: f(0.4), value: 0.85, ease: "easeOut" }]); props.onAnimateText(clip.id, o.id, "opacity", [{ frame: 0, value: 0 }, { frame: f(0.35), value: 1 }]); }}>Slide up</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { props.onAnimateText(clip.id, o.id, "x", [{ frame: 0, value: -0.15 }, { frame: f(0.5), value: 0.5, ease: "easeOut" }]); props.onAnimateText(clip.id, o.id, "opacity", [{ frame: 0, value: 0 }, { frame: f(0.3), value: 1 }]); }}>Fly in</button>
                        {animated && <button className="btn btn-ghost btn-sm" onClick={() => { props.onAnimateText(clip.id, o.id, "x", []); props.onAnimateText(clip.id, o.id, "y", []); props.onAnimateText(clip.id, o.id, "opacity", []); }}>Clear</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="add-col">
              <div className="add-row">
                <input
                  type="text" placeholder="Add a text overlay…" value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newText.trim()) { props.onAddText(clip.id, newText.trim(), newPos); setNewText(""); }
                  }}
                />
                <select value={newPos} onChange={(e) => setNewPos(e.target.value)} aria-label="Text position">
                  {TEXT_POSITIONS.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
              </div>
              <button
                className="btn btn-block" disabled={!newText.trim()}
                onClick={() => { props.onAddText(clip.id, newText.trim(), newPos); setNewText(""); }}
              >
                <Plus size={14} /> Add overlay
              </button>
            </div>
            {overlays.length === 0 && <span className="field-hint">Burned-in text rendered onto this clip — shows live in the preview at the position you pick.</span>}
          </div>
        )}

        {tab === "captions" && (
          <div className="group">
            <div className="group-title">
              <Captions size={13} /> Captions
              {clip.captions?.model ? <span className="field-note" style={{ marginLeft: "auto" }}>{clip.captions.model}</span> : null}
            </div>
            <div className="add-row">
              <select value={capModel} onChange={(e) => setCapModel(e.target.value)} disabled={!connected || busy} aria-label="Whisper model" title="Larger models are more accurate but slower">
                {CAPTION_MODELS.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <button
                className="btn"
                onClick={() => props.onGenerateCaptions(clip.id, capModel)}
                disabled={!connected || busy || !asset?.hasAudio}
                title={asset?.hasAudio ? "Transcribe this clip's audio" : "Clip has no audio"}
              >
                {cues.length ? "Re-transcribe" : "Generate"}
              </button>
              {cues.length > 0 && (
                <button className="btn btn-danger" onClick={() => props.onClearCaptions(clip.id)} disabled={!connected || busy} aria-label="Clear captions">
                  <X size={14} />
                </button>
              )}
            </div>
            {cues.length > 0 && (
              <div className="cap-style">
                <div className="cap-presets" role="group" aria-label="Caption style preset">
                  {CAPTION_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className="cap-preset"
                      onClick={() => props.onCaptionStyle(clip.id, p.style)}
                      disabled={!connected || busy}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <TextStyleEditor style={capStyle} onChange={(patch) => props.onCaptionStyle(clip.id, patch)} />
              </div>
            )}
            {cues.length > 0 ? (
              <div className="cue-list">
                {cues.map((c, i) => (
                  <div className="cue" key={i}>
                    <span className="cue-time">{fmt(c.startFrame / fps)}</span>
                    <span className="cue-text">{c.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="field-hint">Generate burned-in subtitles from this clip's speech with local Whisper — fully offline. Pick a style preset and it previews live over the video.</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ProjectInspector({
  project, clipCount, totalDuration, connected, onImport,
}: {
  project: Project | null;
  clipCount: number;
  totalDuration: number;
  connected: boolean;
  onImport: () => void;
}) {
  return (
    <div className="insp-empty">
      <div className="empty">
        <span className="empty-icon"><Sliders size={20} /></span>
        <span className="empty-title">No clip selected</span>
        <span className="empty-text">Select a clip in the timeline to adjust its trim, color, text, captions and motion graphics.</span>
        <div className="empty-actions">
          <button className="btn btn-sm" onClick={onImport} disabled={!connected}>
            <Import size={14} /> Import media
          </button>
        </div>
        <span className="empty-aside">Motion graphics are added by your AI assistant.</span>
      </div>
      {project && (
        <div className="stat-grid">
          <div className="stat"><div className="k">Resolution</div><div className="v">{project.width}×{project.height}</div></div>
          <div className="stat"><div className="k">Frame rate</div><div className="v">{project.fps}fps</div></div>
          <div className="stat"><div className="k">Clips</div><div className="v">{clipCount}</div></div>
          <div className="stat"><div className="k">Duration</div><div className="v">{fmt(totalDuration)}</div></div>
        </div>
      )}
    </div>
  );
}

// A generic fallback shown only when the app can't resolve its own paths (e.g. a
// plain browser dev run with no Electron bridge). The real app fills this in.
const FALLBACK_SERVER = {
  command: "node",
  args: ["<absolute path to this project>/packages/mcp/dist/index.js"],
};

type McpServer = { command: string; args: string[]; env?: Record<string, string> };

/** JSON `mcpServers` block used by Claude Desktop, Cursor, Windsurf, and Gemini CLI. */
function jsonBlock(server: McpServer): string {
  return JSON.stringify({ mcpServers: { "ai-video-editor": server } }, null, 2);
}

/** TOML `mcp_servers` block used by Codex CLI. */
function tomlBlock(server: McpServer): string {
  const lines = [
    "[mcp_servers.ai-video-editor]",
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
  ];
  if (server.env) lines.push(`env = ${JSON.stringify(server.env)}`);
  return lines.join("\n");
}

/** `claude mcp add` one-liner used by Claude Code (CLI). */
function claudeCodeCommand(server: McpServer): string {
  const envFlags = Object.entries(server.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return ["claude mcp add ai-video-editor", ...envFlags, "--", server.command, ...server.args].join(" ");
}

interface ClientDef {
  id: string;
  label: string;
  /** Where the snippet goes / how to apply it, in order. */
  steps: (server: McpServer) => string[];
  snippet: (server: McpServer) => { code: string; lang: string };
  restart: string;
}

const CLIENTS: ClientDef[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    steps: () => [
      "Open the config file — Windows: %APPDATA%\\Claude\\claude_desktop_config.json · macOS: ~/Library/Application Support/Claude/claude_desktop_config.json",
      "Merge the block below into it (create the file if it doesn't exist).",
    ],
    snippet: (s) => ({ code: jsonBlock(s), lang: "json" }),
    restart: "Fully quit and reopen Claude Desktop (closing the window isn't enough).",
  },
  {
    id: "claude-code",
    label: "Claude Code (CLI)",
    steps: () => [
      "Run this from anywhere — it registers the server for you (add -s user instead of the default project scope to make it available everywhere):",
    ],
    snippet: (s) => ({ code: claudeCodeCommand(s), lang: "bash" }),
    restart: "No restart needed — run `claude mcp list` to verify, then just ask it to edit.",
  },
  {
    id: "cursor",
    label: "Cursor",
    steps: () => [
      "Open (or create) ~/.cursor/mcp.json for all projects, or .cursor/mcp.json in this project for just this one.",
      "Merge the block below into it.",
    ],
    snippet: (s) => ({ code: jsonBlock(s), lang: "json" }),
    restart: "Reload the Cursor window (Command Palette → Reload Window).",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    steps: () => [
      "Open ~/.codeium/windsurf/mcp_config.json (create it if it doesn't exist).",
      "Merge the block below into it.",
    ],
    snippet: (s) => ({ code: jsonBlock(s), lang: "json" }),
    restart: "Reload the Windsurf window, or restart the app.",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    steps: () => [
      "Open ~/.gemini/settings.json (create it if it doesn't exist).",
      "Merge the block below into it.",
    ],
    snippet: (s) => ({ code: jsonBlock(s), lang: "json" }),
    restart: "Restart the Gemini CLI session.",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    steps: () => [
      "Open ~/.codex/config.toml (create it if it doesn't exist).",
      "Append the block below (Codex uses TOML, not JSON).",
    ],
    snippet: (s) => ({ code: tomlBlock(s), lang: "toml" }),
    restart: "Restart the Codex CLI session.",
  },
  {
    id: "other",
    label: "Other MCP client",
    steps: () => [
      "Any MCP-compatible client works. Most use the same JSON `mcpServers` shape below — check your client's docs for its config file location.",
    ],
    snippet: (s) => ({ code: jsonBlock(s), lang: "json" }),
    restart: "Restart your AI client after editing its config.",
  },
];

function ConnectPanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ packaged: boolean; available: boolean; json: string } | null>(null);
  const [clientId, setClientId] = useState(CLIENTS[0].id);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    window.aive?.getMcpConfig?.().then((r) => { if (alive) setInfo(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const resolved = !!info?.available;
  const server: McpServer = useMemo(() => {
    if (!info?.json) return FALLBACK_SERVER;
    try {
      return JSON.parse(info.json).mcpServers["ai-video-editor"] as McpServer;
    } catch {
      return FALLBACK_SERVER;
    }
  }, [info]);

  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0];
  const { code, lang } = client.snippet(server);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the user can still select the text */ }
  };

  return (
    <div className="connect-panel" role="dialog" aria-label="Connect your AI client">
      <div className="connect-head">
        <h3>Connect your AI client</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <p>
        Pick your AI client for the exact steps.
        {resolved
          ? " Paths below are already filled in for this install — copy as-is."
          : " Replace the placeholder path with the absolute path to this project on your machine."}
        {" "}The server attaches to this running editor automatically, so the AI and this window share the same project.
      </p>
      <div className="insp-tabs" role="tablist">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === clientId}
            className={`tab${c.id === clientId ? " active" : ""}`}
            onClick={() => setClientId(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <ol className="connect-steps">
        {client.steps(server).map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <div className="connect-code">
        <button className="copy-btn" onClick={copy} aria-label={`Copy ${lang} config to clipboard`}>
          {copied ? <><Check /> Copied</> : "Copy"}
        </button>
        <pre>{code}</pre>
      </div>
      {info?.packaged && (
        <p className="muted">
          This uses the app's own runtime, so it works even without Node.js installed.
        </p>
      )}
      <p className="muted">{client.restart} Then ask it to import footage and make an edit.</p>
    </div>
  );
}
