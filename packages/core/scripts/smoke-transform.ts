/**
 * Phase 3 smoke: per-clip transform + keyframe animation actually bakes into the
 * FFmpeg export. Builds a 2-track timeline where an overlay clip flies in from
 * the left (x), scales up (scale), fades via opacity keyframes, gets a static
 * rotation+flip, and animates its volume — then renders with real FFmpeg and
 * verifies the geq/volume filtergraph runs and the output matches the canvas.
 *
 * SOTA Phase 4 extension: the FAST AFFINE transform path (scale/rotate/overlay
 * filters) must visually match the old per-pixel geq path — a second timeline
 * that qualifies for the fast path is rendered BOTH ways (AIVE_TRANSFORM_GEQ=1
 * forces geq) and sampled frames must agree in mean RGB within ±3.
 *
 * Run: npx tsx packages/core/scripts/smoke-transform.ts <clipA> [clipB]
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpegStdoutBuffer } from "../src/ffmpeg/executor.js";
import { sampleTrack } from "../src/keyframes.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/** Mean RGB of the frame at `t` (scale-to-1px trick — 3 raw bytes). */
async function meanRgb(path: string, t: number): Promise<[number, number, number]> {
  const buf = await runFfmpegStdoutBuffer([
    "-hide_banner", "-ss", t.toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  return [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0];
}

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

  // --- SOTA Phase 4: fast affine path ⇄ geq path visual equivalence -----------
  console.log("\nfast-path vs geq A/B (static scale/pos/rot/flip + animated x)...");
  const engine2 = new EditorEngine(mkdtempSync(join(tmpdir(), "aive-tf2-")));
  engine2.setProjectSettings({ width: 360, height: 640, fps: 30 });
  const b2 = await engine2.importVideo(clipA);
  const o2 = await engine2.importVideo(clipB);
  engine2.appendClip(b2.id);
  const top2 = engine2.addTrack("video");
  const ov2 = engine2.addClip(o2.id, { trackIndex: top2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
  // Everything here is expressible on the fast path: static scale + rotation +
  // flip + opacity, with ANIMATED x/y (ride the positioning overlay).
  engine2.setClipTransform(ov2.id, { transform: { scale: 0.5, rotation: 20, flipH: true, y: -0.1 }, opacity: 0.85 });
  engine2.setKeyframes(ov2.id, "x", [
    { frame: 0, value: -0.3 },
    { frame: 30, value: 0.2, ease: "easeOut" },
  ]);

  const fastOut = join(engine2.dataDir, "fast.mp4");
  await engine2.exportVideo(fastOut);
  process.env.AIVE_TRANSFORM_GEQ = "1";
  const geqOut = join(engine2.dataDir, "geq.mp4");
  try {
    await engine2.exportVideo(geqOut);
  } finally {
    delete process.env.AIVE_TRANSFORM_GEQ;
  }

  for (const t of [0.2, 1.0, 2.5]) {
    const [fr, fg, fb] = await meanRgb(fastOut, t);
    const [gr, gg, gb] = await meanRgb(geqOut, t);
    const delta = Math.max(Math.abs(fr - gr), Math.abs(fg - gg), Math.abs(fb - gb));
    const ok = delta <= 3;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} t=${t}s mean-RGB fast(${fr},${fg},${fb}) vs geq(${gr},${gg},${gb}) Δ=${delta}`,
    );
  }

  console.log(failures === 0 ? "\nTRANSFORM SMOKE TEST PASSED" : `\nTRANSFORM SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("TRANSFORM SMOKE TEST FAILED:", err);
  process.exit(1);
});
