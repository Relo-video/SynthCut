/**
 * Phase 2 smoke test: crossfade transitions. Builds 3 clips, adds a 1s
 * crossfade entering clip 2 and a hard cut into clip 3, exports, and verifies
 * the output duration reflects the overlap (total - transition durations).
 *
 * Run: npx tsx packages/core/scripts/smoke-transitions.ts <clipA> <clipB>
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-transitions.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-tr-"));
  const engine = new EditorEngine(dataDir);

  const a = await engine.importVideo(clipA); // 5s
  const b = await engine.importVideo(clipB); // 4s
  const fps = engine.fps;
  engine.appendClip(a.id); // clip 1: 5s
  const c2 = engine.appendClip(b.id); // clip 2: 4s
  const c3 = engine.appendClip(a.id); // clip 3: 5s
  console.log(`baseline timeline: ${engine.timelineDuration().toFixed(2)}s (expect ~14)`);

  // 1s crossfade entering clip 2 -> overlaps clip1/clip2 by 1s.
  engine.setTransition(c2.id, "fade", Math.round(1 * fps));
  const afterT = engine.timelineDuration();
  console.log(`after 1s crossfade into clip2: ${afterT.toFixed(2)}s (expect ~13)`);
  if (Math.abs(afterT - 13) > 0.15) throw new Error(`transition duration math wrong: ${afterT}`);

  // dissolve entering clip 3 too.
  engine.setTransition(c3.id, "dissolve", Math.round(0.8 * fps));
  const total = engine.timelineDuration();
  console.log(`after dissolve into clip3: ${total.toFixed(2)}s (expect ~12.2)`);

  const out = join(dataDir, "tr.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (engine est ~${result.duration.toFixed(2)})`);
  if (Math.abs(probed.duration - result.duration) > 0.8) {
    throw new Error(`export duration drift: got ${probed.duration}, expected ${result.duration}`);
  }

  // Verify a hard-cut + transition mix also renders: remove transition on clip2.
  engine.removeTransition(c2.id);
  const out2 = join(dataDir, "tr2.mp4");
  await engine.exportVideo(out2);
  const probed2 = await probeAsset(out2);
  console.log(`mixed cut+transition export: ${probed2.duration.toFixed(2)}s`);

  console.log("\nTRANSITIONS SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("TRANSITIONS SMOKE TEST FAILED:", err);
  process.exit(1);
});
