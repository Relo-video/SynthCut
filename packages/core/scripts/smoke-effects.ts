/**
 * Phase 2 smoke test: verifies per-clip effects actually affect the render.
 * Builds a timeline, applies speed/color/fade/volume, exports, and checks that
 * the exported duration reflects the speed change.
 *
 * Run: npx tsx packages/core/scripts/smoke-effects.ts <clipA> <clipB>
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-effects.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-fx-"));
  const engine = new EditorEngine(dataDir);

  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);
  const fps = engine.fps;
  const c1 = engine.appendClip(a.id);
  const c2 = engine.appendClip(b.id);
  // Expectations derive from the PROBED durations so any test media works.
  console.log(`baseline timeline: ${engine.timelineDuration().toFixed(2)}s (expect ~${(a.duration + b.duration).toFixed(1)})`);

  // Speed up clip A by 2x -> its OWN footprint halves. In the absolute
  // (multi-track) model this does NOT ripple clip B — B keeps its position, so a
  // gap opens. Verify A's footprint shrank rather than the whole-timeline length.
  engine.setClipEffects(c1.id, { speed: 2 });
  const aDur = engine.clipDuration(c1);
  const wantA = a.duration / 2;
  console.log(`after 2x speed on A: clip footprint ${aDur.toFixed(2)}s (expect ~${wantA.toFixed(2)})`);
  if (Math.abs(aDur - wantA) > 0.1) throw new Error(`speed math wrong: clip footprint ${aDur}`);

  // Apply a warm color grade + fades to A, volume + slow-mo to B.
  engine.setClipEffects(c1.id, { color: { contrast: 1.15, saturation: 1.2, brightness: 0.03 }, fadeInFrames: Math.round(0.5 * fps), fadeOutFrames: Math.round(0.5 * fps) });
  engine.setClipEffects(c2.id, { speed: 0.5, volume: 0.4 }); // slow-mo: footprint doubles

  // Close the gap left by A's speed change: place B right after A (positional).
  engine.moveClip(c2.id, Math.round(engine.clipDuration(c1) * fps));
  const total = engine.timelineDuration();
  const wantTotal = wantA + b.duration * 2;
  console.log(`final timeline: ${total.toFixed(2)}s (expect ~${wantTotal.toFixed(1)})`);
  if (Math.abs(total - wantTotal) > 0.15) throw new Error(`final duration wrong: ${total}`);

  // Split the sped-up clip to ensure split math respects speed.
  const { left, right } = engine.splitClip(c1.id, Math.round(1 * fps)); // split A at 1s timeline (=2s source)
  console.log(`split sped clip -> ${left}, ${right}; timeline still ${engine.timelineDuration().toFixed(2)}s`);
  if (Math.abs(engine.timelineDuration() - total) > 0.05) throw new Error("split changed total duration");

  const out = join(dataDir, "fx.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect ~${result.duration.toFixed(2)})`);
  if (Math.abs(probed.duration - result.duration) > 0.6) {
    throw new Error(`export duration drift: got ${probed.duration}, expected ${result.duration}`);
  }

  console.log("\nEFFECTS SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("EFFECTS SMOKE TEST FAILED:", err);
  process.exit(1);
});
