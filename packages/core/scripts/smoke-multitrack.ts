/**
 * Phase 1 smoke test: the multi-track, frame-based timeline + positional
 * compositor. Synthesizes its own solid-color test media (no external files
 * needed), then builds:
 *   - V1 (base): a RED clip then a BLUE clip joined by a crossfade transition,
 *   - V2 (overlay, on top): a GREEN clip placed at an absolute frame,
 *   - A1: an audio-only clip,
 * exports it, and verifies (a) the export dimensions/duration reflect the frame
 * positions and the transition overlap, and (b) the composited center pixel is
 * the OVERLAY color where the overlay sits on top, the BASE color where it does
 * not, and the SECOND base clip's color later — i.e. z-order + positions are
 * correct.
 *
 * Run: npx tsx packages/core/scripts/smoke-multitrack.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";

const FPS = 30;
const W = 1280;
const H = 720;

async function synth(args: string[]): Promise<void> {
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", ...args], { reject: true });
}

/** Sample the center pixel (R,G,B) of a rendered file at time `t` seconds. */
async function centerPixel(file: string, t: number): Promise<[number, number, number]> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    [
      "-hide_banner",
      "-ss",
      t.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1,format=rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { reject: true, encoding: "buffer" },
  );
  const b = stdout as unknown as Buffer;
  return [b[0], b[1], b[2]];
}

function dominant([r, g, b]: [number, number, number]): "red" | "green" | "blue" | "other" {
  if (r > 140 && g < 110 && b < 110) return "red";
  if (g > 140 && r < 110 && b < 110) return "green";
  if (b > 140 && r < 110 && g < 110) return "blue";
  return "other";
}

async function expectColor(file: string, frame: number, want: "red" | "green" | "blue", label: string) {
  const px = await centerPixel(file, frame / FPS);
  const got = dominant(px);
  console.log(`  frame ${frame} (${label}): rgb(${px.join(",")}) -> ${got} (expect ${want})`);
  if (got !== want) throw new Error(`Layering wrong at frame ${frame} (${label}): expected ${want}, got ${got} rgb(${px.join(",")})`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "aive-mt-"));
  const red = join(dir, "red.mp4");
  const blue = join(dir, "blue.mp4");
  const green = join(dir, "green.mp4");
  const tone = join(dir, "tone.m4a");

  // Synthesize solid-color clips (with audio on the base ones) + an audio bed.
  await synth(["-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=${FPS}:d=5`, "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-pix_fmt", "yuv420p", red]);
  await synth(["-f", "lavfi", "-i", `color=c=blue:s=${W}x${H}:r=${FPS}:d=4`, "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-shortest", "-pix_fmt", "yuv420p", blue]);
  await synth(["-f", "lavfi", "-i", `color=c=0x00FF00:s=${W}x${H}:r=${FPS}:d=2`, "-pix_fmt", "yuv420p", green]);
  await synth(["-f", "lavfi", "-i", "sine=frequency=220:duration=8", tone]);

  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name: "multitrack-smoke" });

  const aRed = await engine.importVideo(red);
  const aBlue = await engine.importVideo(blue);
  const aGreen = await engine.importVideo(green);
  const aTone = await engine.importVideo(tone);

  // V1 base: RED [0,150) then BLUE appended, then crossfade into BLUE (30f overlap).
  const clipA = engine.addClip(aRed.id, { startFrame: 0 }); // [0,150)
  const clipB = engine.appendClip(aBlue.id); // [150,270)
  engine.setTransition(clipB.id, "fade", 30); // BLUE -> [120,240); total V1 end = 240

  // V2 overlay track (on top): GREEN [30,90).
  const v2 = engine.addTrack("video", { name: "V2" });
  engine.addClip(aGreen.id, { trackIndex: v2.index, startFrame: 30 }); // [30,90)

  // A1 audio track: the tone, full length.
  const a1 = engine.addTrack("audio", { name: "A1" });
  engine.addClip(aTone.id, { trackIndex: a1.index, startFrame: 0 });

  // ---- structural assertions -----------------------------------------------
  const totalFrames = engine.timelineDurationFrames();
  console.log(`timeline: ${engine.getProject().tracks.length} tracks, total ${totalFrames}f (${(totalFrames / FPS).toFixed(2)}s, expect 240f/8.00s)`);
  if (totalFrames !== 240) throw new Error(`expected 240 total frames, got ${totalFrames}`);
  if (clipA.startFrame !== 0) throw new Error("clipA not at frame 0");

  // ---- render + probe -------------------------------------------------------
  const out = join(dir, "out.mp4");
  const result = await engine.exportVideo(out);
  const { stdout: probeJson } = await execa("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "json", out,
  ]);
  const probe = JSON.parse(probeJson);
  const pw = probe.streams[0].width;
  const ph = probe.streams[0].height;
  const pdur = Number(probe.format.duration);
  console.log(`exported: ${pw}x${ph} ${pdur.toFixed(2)}s (engine est ${result.duration.toFixed(2)}s)`);
  if (pw !== W || ph !== H) throw new Error(`export dimensions ${pw}x${ph} != ${W}x${H}`);
  if (Math.abs(pdur - 8) > 0.6) throw new Error(`export duration ${pdur} != ~8s`);

  // ---- layering + position assertions (center pixel) ------------------------
  await expectColor(out, 60, "green", "overlay on top of base");
  await expectColor(out, 105, "red", "overlay gone, base RED visible");
  await expectColor(out, 200, "blue", "second base clip after transition");

  console.log("\nMULTITRACK SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("MULTITRACK SMOKE TEST FAILED:", err);
  process.exit(1);
});
