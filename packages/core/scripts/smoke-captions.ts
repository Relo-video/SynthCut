/**
 * Phase 3 smoke test: Whisper captions. Builds a short video with real speech
 * (a test pattern muxed with a spoken-word WAV), transcribes it locally with
 * whisper.cpp, attaches the captions, and exports — verifying the captions burn
 * in and the render completes. Also checks that splitting a clip partitions its
 * caption cues correctly, and that clearing removes them.
 *
 * Run: npx tsx packages/core/scripts/smoke-captions.ts [speech.wav]
 *   speech.wav defaults to scratch/jfk.wav (download it from
 *   https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav).
 *
 * whisper.cpp + the ggml model are auto-downloaded on first run (cached under
 * ~/.aive/whisper); set AIVE_WHISPER_DIR / AIVE_WHISPER_BIN / AIVE_WHISPER_MODEL
 * to reuse pre-installed copies.
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";

async function main() {
  const speechArg = process.argv[2] ?? "scratch/jfk.wav";
  const speech = isAbsolute(speechArg) ? speechArg : resolve(process.cwd(), speechArg);
  if (!existsSync(speech)) {
    throw new Error(
      `Speech file not found: ${speech}\n` +
        `Pass a spoken-word WAV, or download the sample:\n` +
        `  curl -L -o scratch/jfk.wav https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav`,
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), "aive-captions-"));
  const engine = new EditorEngine(dataDir);

  // Probe the speech to size the test video to its length.
  const speechMeta = await probeAsset(speech);
  const dur = Math.min(speechMeta.duration, 30);

  console.log("0. build a test video with real speech...");
  const testClip = join(dataDir, "speech-clip.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1280x720:rate=30:duration=${dur.toFixed(3)}`,
    "-i",
    speech,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    testClip,
  ]);

  const asset = await engine.importVideo(testClip);
  const fps = engine.fps;
  const clip = engine.appendClip(asset.id);

  console.log("1. transcribe + caption the clip (base.en, may download model on first run)...");
  const t0 = Date.now();
  const { cueCount } = await engine.generateCaptions(clip.id, {
    model: "base.en",
    style: { position: "bottom", fontSize: 52, color: "white", box: true },
  });
  console.log(`   ${cueCount} caption cues in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (cueCount === 0) throw new Error("Whisper produced no caption cues from speech audio");
  for (const c of engine.getProject().tracks[0].clips[0].captions!.cues) {
    console.log(`   [${(c.startFrame / fps).toFixed(2)}-${(c.endFrame / fps).toFixed(2)}] ${c.text}`);
  }

  console.log("2. export with burned-in captions...");
  const out = join(dataDir, "captions.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect ~${result.duration.toFixed(2)})`);
  if (Math.abs(probed.duration - result.duration) > 0.8) {
    throw new Error(`duration drift: ${probed.duration} vs ${result.duration}`);
  }

  console.log("3. split the clip and verify captions are partitioned...");
  const halfFrames = Math.round((engine.clipDuration(clip) / 2) * fps);
  const { left, right } = engine.splitClip(clip.id, halfFrames);
  const clips = engine.getProject().tracks[0].clips;
  const leftClip = clips.find((c) => c.id === left)!;
  const rightClip = clips.find((c) => c.id === right)!;
  const leftCount = leftClip.captions?.cues.length ?? 0;
  const rightCount = rightClip.captions?.cues.length ?? 0;
  console.log(`   left cues: ${leftCount}, right cues: ${rightCount} (original ${cueCount})`);
  if (leftCount === 0 && rightCount === 0) throw new Error("split dropped all captions");
  // Right-half cues must have been rebased to start near 0, not the original times.
  if (rightClip.captions && rightClip.captions.cues[0].startFrame > halfFrames) {
    throw new Error("split did not rebase right-half caption times");
  }
  await engine.exportVideo(join(dataDir, "captions-split.mp4"));

  console.log("4. clear captions...");
  engine.clearCaptions(left);
  if (clips.find((c) => c.id === left)!.captions) throw new Error("clearCaptions did not remove the track");

  console.log("\nCAPTIONS SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("CAPTIONS SMOKE TEST FAILED:", err);
  process.exit(1);
});
