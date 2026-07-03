/**
 * End-to-end smoke test for the core engine. Imports two real (generated) test
 * clips of *different* resolutions, performs edits, exports, and verifies the
 * output via ffprobe. Run: `npx tsx packages/core/scripts/smoke.ts <a> <b>`
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-smoke-"));
  const engine = new EditorEngine(dataDir);

  let changes = 0;
  engine.on("change", () => changes++);

  console.log("1. importing assets...");
  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);
  console.log(`   A: ${a.name} ${a.width}x${a.height} ${a.duration}s audio=${a.hasAudio}`);
  console.log(`   B: ${b.name} ${b.width}x${b.height} ${b.duration}s audio=${b.hasAudio}`);
  console.log(`   canvas adopted: ${engine.canvas.width}x${engine.canvas.height}@${engine.canvas.fps}`);

  console.log("2. building timeline (append A, append B)...");
  const c1 = engine.appendClip(a.id);
  engine.appendClip(b.id);
  console.log(`   timeline duration: ${engine.timelineDuration().toFixed(2)}s`);

  console.log("3. cut 1s..2s out of first clip...");
  const fps = engine.fps;
  engine.cutRange(c1.id, Math.round(1 * fps), Math.round(2 * fps));
  const afterCut = engine.timelineDuration();
  console.log(`   timeline duration after cut: ${afterCut.toFixed(2)}s`);

  console.log("4. undo the cut...");
  engine.undo();
  console.log(`   timeline duration after undo: ${engine.timelineDuration().toFixed(2)}s`);
  engine.redo();
  console.log(`   timeline duration after redo: ${engine.timelineDuration().toFixed(2)}s`);

  console.log("5. exporting...");
  const out = join(dataDir, "out.mp4");
  const result = await engine.exportVideo(out);
  console.log(`   exported: ${result.path}`);

  console.log("6. verifying export with ffprobe...");
  const probed = await probeAsset(out);
  console.log(`   output: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s audio=${probed.hasAudio}`);

  const expected = a.duration - 1 + b.duration;
  const drift = Math.abs(probed.duration - expected);
  console.log(`   expected ~${expected.toFixed(2)}s, drift ${drift.toFixed(2)}s`);

  console.log("7. preview render...");
  const preview = await engine.renderPreview();
  const previewProbe = await probeAsset(preview.path);
  console.log(`   preview: ${previewProbe.width}x${previewProbe.height} ${previewProbe.duration.toFixed(2)}s`);

  if (drift > 0.5) throw new Error(`Export duration drift too large: ${drift}s`);
  if (changes < 4) throw new Error(`Expected >=4 change events, got ${changes}`);
  console.log(`\nSMOKE TEST PASSED (${changes} change events, drift ${drift.toFixed(3)}s)`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
