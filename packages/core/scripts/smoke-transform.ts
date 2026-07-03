/**
 * Phase 3 smoke: per-clip transform + keyframe animation actually bakes into the
 * FFmpeg export. Builds a 2-track timeline where an overlay clip flies in from
 * the left (x), scales up (scale), fades via opacity keyframes, gets a static
 * rotation+flip, and animates its volume — then renders with real FFmpeg and
 * verifies the geq/volume filtergraph runs and the output matches the canvas.
 *
 * Run: npx tsx packages/core/scripts/smoke-transform.ts <clipA> [clipB]
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { sampleTrack } from "../src/keyframes.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipBArg] = process.argv;
  if (!clipA) throw new Error("usage: smoke-transform.ts <clipA> [clipB]");
  const clipB = clipBArg ?? clipA;

  const dataDir = mkdtempSync(join(tmpdir(), "aive-tf-"));
  const engine = new EditorEngine(dataDir);
  // Small vertical canvas: geq is a per-pixel expression, so keep the smoke quick
  // while still exercising the exact transform/keyframe filtergraph.
  engine.setProjectSettings({ width: 360, height: 640, fps: 30 });
  const fps = engine.fps;

  const base = await engine.importVideo(clipA);
  const over = await engine.importVideo(clipB);

  // Base layer on V1, a shorter overlay clip on V2 (composites on top).
  const baseClip = engine.appendClip(base.id);
  const vTop = engine.addTrack("video");
  const ovClip = engine.addClip(over.id, { trackIndex: vTop.index, startFrame: 0 });
  // Phase 4: per-track audio gain — exercises the trackVolume bake in the mix.
  engine.setTrackProperties(vTop.index, { volume: 0.5 });

  // Animate the overlay: fly in from left + scale up + opacity ramp (0..15f),
  // a static 8° rotation + horizontal flip, and a volume swell.
  engine.setClipTransform(ovClip.id, { transform: { rotation: 8, flipH: true } });
  engine.setKeyframes(ovClip.id, "x", [
    { frame: 0, value: -0.5 },
    { frame: 15, value: 0, ease: "easeOut" },
  ]);
  engine.setKeyframes(ovClip.id, "scale", [
    { frame: 0, value: 0.4 },
    { frame: 15, value: 0.6, ease: "easeOut" },
    { frame: 40, value: 0.55 },
  ]);
  engine.setKeyframes(ovClip.id, "opacity", [
    { frame: 0, value: 0 },
    { frame: 12, value: 1, ease: "easeIn" },
  ]);
  engine.setKeyframes(ovClip.id, "volume", [
    { frame: 0, value: 0 },
    { frame: 20, value: 1 },
  ]);

  // --- pure interpolation sanity (the same math the preview + bake use) -------
  let failures = 0;
  const expect = (name: string, got: number, want: number, eps = 0.01) => {
    const ok = Math.abs(got - want) <= eps;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: got ${got.toFixed(3)} want ${want.toFixed(3)}`);
  };
  const xKf = [{ frame: 0, value: -0.5 }, { frame: 15, value: 0, ease: "easeOut" as const }];
  expect("x @0", sampleTrack(xKf, 0), -0.5);
  expect("x @15", sampleTrack(xKf, 15), 0);
  // easeOut at u=0.5 → 1-(0.5)^2 = 0.75 → -0.5 + 0.5*0.75 = -0.125
  expect("x @7.5 (easeOut)", sampleTrack(xKf, 7.5), -0.125);
  const scaleKf = [{ frame: 0, value: 0.4 }, { frame: 15, value: 0.6, ease: "easeOut" as const }, { frame: 40, value: 0.55 }];
  expect("scale @40", sampleTrack(scaleKf, 40), 0.55);
  expect("scale clamps after last", sampleTrack(scaleKf, 999), 0.55);

  // --- real render: the geq transform + animated volume must run --------------
  const out = join(dataDir, "transform.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`\nexported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (canvas 360x640, expect ~${result.duration.toFixed(2)}s)`);
  if (probed.width !== 360 || probed.height !== 640) {
    failures++;
    console.log(`  FAIL output dims ${probed.width}x${probed.height} != 360x640`);
  }
  if (Math.abs(probed.duration - result.duration) > 0.6) {
    failures++;
    console.log(`  FAIL export duration drift: got ${probed.duration}, expected ${result.duration}`);
  }

  console.log(failures === 0 ? "\nTRANSFORM SMOKE TEST PASSED" : `\nTRANSFORM SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("TRANSFORM SMOKE TEST FAILED:", err);
  process.exit(1);
});
