/**
 * Phase 2 smoke test: burned-in text overlays (drawtext). Adds a title and a
 * timed lower-third to clips, exports, and verifies it renders to completion.
 *
 * Run: npx tsx packages/core/scripts/smoke-text.ts <clipA> <clipB>
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-text.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-text-"));
  const engine = new EditorEngine(dataDir);

  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);
  const fps = engine.fps;
  const c1 = engine.appendClip(a.id);
  const c2 = engine.appendClip(b.id);

  console.log("1. add a centered title to clip 1 (first 2s)...");
  const t1 = engine.addTextOverlay(c1.id, { text: "My Awesome Video", position: "center", fontSize: 64, startFrame: 0, endFrame: Math.round(2 * fps) });
  console.log(`   overlay id: ${t1.id}`);

  console.log("2. add a bottom lower-third to clip 2...");
  engine.addTextOverlay(c2.id, { text: "Chapter 2: The Edit", position: "bottom", fontSize: 40, color: "yellow" });

  console.log("3. export...");
  const out = join(dataDir, "text.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect ~${result.duration.toFixed(2)})`);
  if (Math.abs(probed.duration - result.duration) > 0.8) throw new Error(`duration drift: ${probed.duration} vs ${result.duration}`);

  console.log("4. remove one overlay, re-export...");
  engine.removeTextOverlay(c1.id, t1.id);
  await engine.exportVideo(join(dataDir, "text2.mp4"));

  console.log("\nTEXT OVERLAY SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("TEXT OVERLAY SMOKE TEST FAILED:", err);
  process.exit(1);
});
