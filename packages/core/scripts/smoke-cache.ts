/**
 * SOTA Phase 4 deliverable: the segment render cache makes previews incremental.
 *  - First preview of a 3-clip timeline renders all segments.
 *  - An edit at the TAIL re-renders ONLY the tail segment (head segments hit
 *    the cache).
 *  - renderFrame over an unchanged region renders NOTHING new (pure cache).
 *  - The assembled preview probes at the right duration/size.
 *
 * Run: npx tsx packages/core/scripts/smoke-cache.ts
 * (Self-contained — synthesizes three colored clips with ffmpeg lavfi.)
 */
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-cache-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 640, height: 360, fps: 30 });

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. synthesize three 4s colored clips...");
  const assets: string[] = [];
  for (const color of ["red", "green", "blue"]) {
    const p = join(dataDir, `${color}.mp4`);
    await runFfmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=640x360:d=4:r=30`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", p,
    ]);
    const a = await engine.importVideo(p);
    assets.push(a.id);
    engine.appendClip(a.id);
  }

  console.log("2. first preview renders every segment...");
  const r1 = await engine.renderPreview();
  check(existsSync(r1.path), "preview file exists");
  const probed = await probeAsset(r1.path);
  check(Math.abs(probed.duration - 12) < 0.5, `preview duration ≈ 12s (got ${probed.duration.toFixed(2)})`);
  check(probed.width === 640 && probed.height === 360, `preview canvas 640x360 (got ${probed.width}x${probed.height})`);
  const firstRenders = engine.renderStats.segmentRenders;
  check(firstRenders >= 3, `all segments rendered on first pass (${firstRenders})`);
  check(engine.renderStats.singlePassRenders === 0, "segmented path was used (no single-pass fallback)");

  console.log("3. edit at the TAIL → only tail segments re-render...");
  const summary = engine.getProject();
  const lastTrack = summary.tracks.find((t) => t.kind === "video")!;
  const lastClip = lastTrack.clips[lastTrack.clips.length - 1];
  engine.setClipEffects(lastClip.id, { color: { saturation: 0.2 } });

  const before = engine.renderStats.segmentRenders;
  const hitsBefore = engine.renderStats.segmentCacheHits;
  await engine.renderPreview();
  const tailRenders = engine.renderStats.segmentRenders - before;
  const tailHits = engine.renderStats.segmentCacheHits - hitsBefore;
  check(tailRenders >= 1, `the edited tail segment re-rendered (${tailRenders})`);
  check(tailRenders < firstRenders, `fewer renders than the first pass (${tailRenders} < ${firstRenders})`);
  check(tailHits >= 2, `head segments came from cache (${tailHits} hits)`);

  console.log("4. renderFrame over an unchanged region is pure cache...");
  // Invalidate the full-preview shortcut with a NEW tail edit, then ask for a
  // frame in the (untouched) first clip: the head segment must come from cache.
  engine.setClipEffects(lastClip.id, { color: { saturation: 1.8 } });
  const b2 = engine.renderStats.segmentRenders;
  const h2 = engine.renderStats.segmentCacheHits;
  const frame = await engine.renderFrame(1.0);
  check(existsSync(frame), "frame extracted");
  check(engine.renderStats.segmentRenders === b2, `no segment re-rendered for the head frame (${engine.renderStats.segmentRenders - b2})`);
  check(engine.renderStats.segmentCacheHits === h2 + 1, "the head segment was a cache hit");

  console.log("5. AIVE_SEGMENT_CACHE=off falls back to single-pass...");
  process.env.AIVE_SEGMENT_CACHE = "off";
  try {
    const sp = engine.renderStats.singlePassRenders;
    await engine.renderPreview();
    check(engine.renderStats.singlePassRenders === sp + 1, "single-pass path used when cache disabled");
  } finally {
    delete process.env.AIVE_SEGMENT_CACHE;
  }

  console.log(failures === 0 ? "\nCACHE SMOKE TEST PASSED" : `\nCACHE SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CACHE SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
