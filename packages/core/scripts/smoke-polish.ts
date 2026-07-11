/**
 * SOTA Phase 5 deliverables (the small pro-polish set), driven via RPC:
 *  - export_captions / import_captions round-trip (SRT and VTT) with absolute↔
 *    clip-local time conversion.
 *  - Named markers: set_markers accepts numbers AND {frame,name,color,note};
 *    timeline_summary carries them; fps rescale preserves them.
 *  - drawtext word wrap: pure checks on the wrap heuristic + newline respect.
 *
 * Run: npx tsx packages/core/scripts/smoke-polish.ts
 * (Self-contained — synthesizes media with ffmpeg lavfi.)
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { parseSrt, parseVtt, formatSrt, formatVtt } from "../src/captions/srt.js";
import { wrapText, maxCharsPerLine } from "../src/text/wrap.js";
import type { Marker } from "../src/types.js";

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-polish-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 640, height: 360, fps: 30 });

  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. srt/vtt parse⇄format round-trips (pure)...");
  const cues = [
    { start: 1.2, end: 3.44, text: "Hello there" },
    { start: 4.0, end: 6.5, text: "Two lines\nof caption" },
  ];
  const viaSrt = parseSrt(formatSrt(cues));
  const viaVtt = parseVtt(formatVtt(cues));
  check(viaSrt.length === 2 && Math.abs(viaSrt[0].start - 1.2) < 2e-3 && viaSrt[1].text.includes("\n"), "SRT round-trip keeps times + newlines");
  check(viaVtt.length === 2 && Math.abs(viaVtt[1].end - 6.5) < 2e-3, "VTT round-trip keeps times");

  console.log("2. import_captions → export_captions through the engine...");
  const src = join(dataDir, "clip.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=8:r=30",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", src,
  ]);
  const { asset } = await call<{ asset: { id: string } }>("import_video", { path: src });
  // Clip placed at 2s so absolute↔local conversion is non-trivial.
  const clip = (await call<{ clip: { id: string } }>("add_clip", { assetId: asset.id, startFrame: 60 })).clip;

  const sidecarIn = join(dataDir, "in.srt");
  writeFileSync(sidecarIn, formatSrt([
    { start: 3.0, end: 4.5, text: "First cue" },
    { start: 5.0, end: 7.0, text: "Second cue" },
    { start: 30.0, end: 31.0, text: "Outside the clip" },
  ]), "utf8");
  const imp = await call<{ cueCount: number; dropped: number }>("import_captions", { clipId: clip.id, path: sidecarIn });
  check(imp.cueCount === 2 && imp.dropped === 1, `2 cues imported, 1 outside dropped (got ${imp.cueCount}/${imp.dropped})`);

  const state = await call<{ tracks: { clips: { id: string; captions?: { cues: { startFrame: number }[] } }[] }[] }>("get_state", {});
  const placed = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
  check(placed?.captions?.cues[0].startFrame === 30, `absolute 3.0s → clip-local frame 30 (got ${placed?.captions?.cues[0].startFrame})`);

  const outVtt = join(dataDir, "out.vtt");
  const exp = await call<{ cueCount: number; format: string }>("export_captions", { path: outVtt });
  check(exp.cueCount === 2 && exp.format === "vtt", "export_captions wrote both cues as VTT");
  const roundTripped = parseVtt(readFileSync(outVtt, "utf8"));
  check(Math.abs(roundTripped[0].start - 3.0) < 0.04, `exported cue back at absolute ~3.0s (got ${roundTripped[0].start})`);

  console.log("3. named markers via RPC + summary + fps rescale...");
  await call("set_markers", { frames: [30, { frame: 90, name: "Review", color: "#ff5555", note: "tighten this pause?" }] });
  const summary = await call<{ markers: Marker[] }>("timeline_summary", {});
  check(summary.markers.length === 2, "summary carries both markers");
  check(summary.markers[1].name === "Review" && /pause/.test(summary.markers[1].note ?? ""), "named marker keeps name + note");
  await call("set_project_settings", { fps: 60 });
  const rescaled = await call<{ markers: Marker[] }>("timeline_summary", {});
  check(rescaled.markers[1].frame === 180 && rescaled.markers[1].name === "Review", `fps rescale doubles marker frames, keeps names (got ${rescaled.markers[1].frame})`);

  console.log("4. drawtext word wrap heuristic (pure)...");
  const budget = maxCharsPerLine(1080, 54); // vertical canvas, big title
  const wrapped = wrapText("The quick brown fox jumps over the lazy dog and keeps on running", budget);
  check(wrapped.includes("\n"), "long text wraps");
  check(wrapped.split("\n").every((l) => l.length <= budget), "no wrapped line exceeds the budget");
  check(wrapText("keep\nmy breaks", 5) === "keep\nmy breaks", "authored newlines are never re-wrapped");

  console.log(failures === 0 ? "\nPOLISH SMOKE TEST PASSED" : `\nPOLISH SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("POLISH SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
