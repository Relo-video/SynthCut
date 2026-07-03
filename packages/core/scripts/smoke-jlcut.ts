/**
 * Phase 3 smoke test: J/L cuts (audio leads/trails the picture).
 *
 * Builds two clips: A is video-only (silent), B carries a loud 880 Hz tone.
 * A plays first, then B. We apply a J-cut on B (audio leads by 1s) and prove
 * the soundtrack is now audible *during A's video tail* — exactly where it is
 * silent with no offset. Verified by measuring loudness of the rendered audio
 * in time windows before vs. after the audio-lead point. Also checks a J-cut
 * coexists with a transition.
 *
 * Run: npx tsx packages/core/scripts/smoke-jlcut.ts
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg, runFfmpegCaptureStderr } from "../src/ffmpeg/executor.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/** Mean loudness (dBFS) of a time window of a file; -100 ≈ silence. */
async function meanVolumeDb(file: string, ss: number, t: number): Promise<number> {
  const stderr = await runFfmpegCaptureStderr([
    "-hide_banner",
    "-ss",
    ss.toFixed(3),
    "-t",
    t.toFixed(3),
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = stderr.match(/mean_volume:\s*(-?[0-9.]+|-inf) dB/);
  if (!m) return -100;
  return m[1] === "-inf" ? -100 : Number(m[1]);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-jlcut-"));
  const engine = new EditorEngine(dataDir);

  console.log("0. build clip A (video only, silent) and clip B (video + 880Hz tone)...");
  const clipADur = 3;
  const clipBDur = 3;
  const aPath = join(dataDir, "a.mp4");
  const bPath = join(dataDir, "b.mp4");
  await runFfmpeg([
    "-hide_banner", "-f", "lavfi", "-i", `testsrc=size=640x360:rate=30:duration=${clipADur}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", "-t", String(clipADur), "-y", aPath,
  ]);
  await runFfmpeg([
    "-hide_banner",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${clipBDur}`,
    "-f", "lavfi", "-i", `sine=frequency=880:duration=${clipBDur}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", bPath,
  ]);

  const a = await engine.importVideo(aPath);
  const b = await engine.importVideo(bPath);
  if (a.hasAudio) throw new Error("test setup: clip A should have no audio");
  const fps = engine.fps;
  const ca = engine.appendClip(a.id);
  const cb = engine.appendClip(b.id);
  console.log(`   A hasAudio=${a.hasAudio}, B hasAudio=${b.hasAudio}; cut at t=${clipADur}s`);

  // Windows: [0.5,1.0] = early in A (always silent); [2.2,2.8] = A's tail,
  // where B's audio leads after a 1s J-cut.
  const earlyWin: [number, number] = [0.5, 0.5];
  const tailWin: [number, number] = [2.2, 0.6];

  console.log("1. control export (no offset) — A's tail should be silent...");
  const ctrl = join(dataDir, "control.mp4");
  await engine.exportVideo(ctrl);
  const ctrlTail = await meanVolumeDb(ctrl, tailWin[0], tailWin[1]);
  console.log(`   A-tail mean volume = ${ctrlTail.toFixed(1)} dB (expect silence)`);
  if (ctrlTail > -70) throw new Error(`control A-tail not silent (${ctrlTail} dB)`);

  console.log("2. apply J-cut: B audio leads by 1.0s, re-export...");
  engine.setClipAudioOffset(cb.id, Math.round(-1.0 * fps));
  const jcut = join(dataDir, "jcut.mp4");
  const res = await engine.exportVideo(jcut);
  const probed = await probeAsset(jcut);
  if (Math.abs(probed.duration - res.duration) > 0.8) throw new Error(`duration drift: ${probed.duration} vs ${res.duration}`);

  const jEarly = await meanVolumeDb(jcut, earlyWin[0], earlyWin[1]);
  const jTail = await meanVolumeDb(jcut, tailWin[0], tailWin[1]);
  console.log(`   early-A mean volume = ${jEarly.toFixed(1)} dB (expect silence)`);
  console.log(`   A-tail mean volume  = ${jTail.toFixed(1)} dB (expect TONE — audio leads)`);
  if (jEarly > -70) throw new Error(`J-cut leaked audio before the lead point (${jEarly} dB)`);
  if (jTail < -45) throw new Error(`J-cut audio did not lead into A's tail (${jTail} dB)`);
  if (jTail - ctrlTail < 30) throw new Error(`no clear loudness increase from the J-cut (${ctrlTail} -> ${jTail} dB)`);

  console.log("3. J-cut coexists with a transition (render must still complete)...");
  engine.setTransition(cb.id, "fade", Math.round(0.5 * fps));
  const combo = join(dataDir, "jcut-xfade.mp4");
  const cres = await engine.exportVideo(combo);
  const cprobed = await probeAsset(combo);
  console.log(`   rendered ${cprobed.duration.toFixed(2)}s (expect ~${cres.duration.toFixed(2)})`);
  if (Math.abs(cprobed.duration - cres.duration) > 0.8) throw new Error(`combo duration drift: ${cprobed.duration} vs ${cres.duration}`);

  console.log("4. re-lock audio (offset 0) restores silence in A's tail...");
  engine.removeTransition(cb.id);
  engine.setClipAudioOffset(cb.id, 0);
  const relocked = join(dataDir, "relocked.mp4");
  await engine.exportVideo(relocked);
  const rTail = await meanVolumeDb(relocked, tailWin[0], tailWin[1]);
  console.log(`   A-tail mean volume = ${rTail.toFixed(1)} dB (expect silence again)`);
  if (rTail > -70) throw new Error(`re-locking did not restore silence (${rTail} dB)`);

  console.log("\nJ/L CUT SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("J/L CUT SMOKE TEST FAILED:", err);
  process.exit(1);
});
