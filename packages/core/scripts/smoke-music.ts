/**
 * Phase 2 smoke test: background music + ducking. Builds a timeline, adds
 * looping/trimmed background music with fades and sidechain ducking, exports,
 * and verifies the result has audio and matches the timeline length.
 *
 * Run: npx tsx packages/core/scripts/smoke-music.ts <clipA> <clipB> <music>
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB, music] = process.argv;
  if (!clipA || !clipB || !music) throw new Error("usage: smoke-music.ts <clipA> <clipB> <music>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-music-"));
  const engine = new EditorEngine(dataDir);

  const a = await engine.importVideo(clipA); // 5s, has audio
  const b = await engine.importVideo(clipB); // 4s, no audio
  const m = await engine.importVideo(music); // 12s audio-only
  console.log(`music asset: ${m.name} hasVideo=${m.hasVideo} hasAudio=${m.hasAudio} ${m.duration}s`);
  if (m.hasVideo || !m.hasAudio) throw new Error("music asset should be audio-only");

  engine.appendClip(a.id);
  engine.appendClip(b.id);
  const timeline = engine.timelineDuration();
  console.log(`timeline: ${timeline.toFixed(2)}s (expect ~9)`);

  console.log("set ducked music (vol 0.3, 1s fades)...");
  engine.setMusic(m.id, { volume: 0.3, fadeInFrames: engine.fps, fadeOutFrames: engine.fps, duck: true });

  const out = join(dataDir, "music.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s audio=${probed.hasAudio} (music looped+ducked under ${timeline.toFixed(2)}s)`);
  if (!probed.hasAudio) throw new Error("export has no audio track");
  if (Math.abs(probed.duration - result.duration) > 0.8) throw new Error(`duration drift: ${probed.duration} vs ${result.duration}`);

  console.log("switch to non-ducked music and re-export...");
  engine.setMusic(m.id, { volume: 0.5, duck: false });
  const out2 = join(dataDir, "music2.mp4");
  await engine.exportVideo(out2);
  const probed2 = await probeAsset(out2);
  console.log(`non-ducked export: ${probed2.duration.toFixed(2)}s audio=${probed2.hasAudio}`);
  if (!probed2.hasAudio) throw new Error("non-ducked export has no audio");

  console.log("\nMUSIC + DUCKING SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("MUSIC SMOKE TEST FAILED:", err);
  process.exit(1);
});
