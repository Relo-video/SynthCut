/**
 * Phase 5 smoke test: PACKAGED / OFFLINE bundle.
 *
 * Points every engine binary/model override (AIVE_FFMPEG, AIVE_FFPROBE,
 * AIVE_WHISPER_BIN, AIVE_WHISPER_MODEL, AIVE_YUNET_MODEL, AIVE_FONT) at the
 * staged bundle produced by `apps/desktop/scripts/prepare-bundle.ts`, then runs a
 * real captioned export. This proves the bundled ffmpeg + whisper.cpp (+ base.en
 * model) + the bundled OSS font all work together with NO reliance on a PATH
 * ffmpeg, no system fonts, and no first-run downloads — i.e. the offline-first
 * guarantee a packaged installer must deliver. It also loads the bundled YuNet
 * ONNX to confirm it's a valid model file.
 *
 * Prereq: run the staging script first so build/resources/aive exists:
 *   node apps/desktop/scripts/prepare-bundle.ts
 *
 * Run (paths are ABSOLUTE as required by importVideo):
 *   npx tsx packages/core/scripts/smoke-bundled.ts [speech.wav]
 *   speech.wav defaults to scratch/jfk.wav.
 */
import { join, isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const BUNDLE = join(repoRoot, "apps", "desktop", "build", "resources", "aive");
const isWin = process.platform === "win32";
const exe = (n: string) => (isWin ? `${n}.exe` : n);

function need(p: string, what: string): string {
  if (!existsSync(p)) {
    throw new Error(
      `Bundled ${what} missing: ${p}\nRun the staging script first:\n` +
        `  node apps/desktop/scripts/prepare-bundle.ts`,
    );
  }
  return p;
}

// Wire the engine to the bundled artifacts BEFORE importing engine code, so the
// modules pick these up. (The engine reads these env vars at call time, so order
// is not strictly required, but this makes intent obvious.)
process.env.AIVE_FFMPEG = need(join(BUNDLE, "ffmpeg", exe("ffmpeg")), "ffmpeg");
process.env.AIVE_FFPROBE = need(join(BUNDLE, "ffmpeg", exe("ffprobe")), "ffprobe");
process.env.AIVE_WHISPER_BIN = need(join(BUNDLE, "whisper", "bin", exe("whisper-cli")), "whisper-cli");
process.env.AIVE_WHISPER_MODEL = need(join(BUNDLE, "whisper", "models", "ggml-base.en.bin"), "whisper model");
process.env.AIVE_YUNET_MODEL = need(join(BUNDLE, "models", "face_detection_yunet_2023mar.onnx"), "YuNet model");
process.env.AIVE_FONT = need(join(BUNDLE, "fonts", "NotoSans-Regular.ttf"), "font");

const { EditorEngine } = await import("../src/engine.js");
const { probeAsset } = await import("../src/ffmpeg/ffprobe.js");
const { runFfmpeg, checkBinaries } = await import("../src/ffmpeg/executor.js");
const { ensureYunetModel } = await import("../src/reframe/detector.js");

async function main() {
  console.log(`Using bundle at: ${BUNDLE}\n`);

  console.log("0. confirm the BUNDLED ffmpeg/ffprobe are the ones being used...");
  const ver = await checkBinaries();
  console.log(`   ffmpeg:  ${ver.ffmpeg}`);
  console.log(`   ffprobe: ${ver.ffprobe}`);

  const speechArg = process.argv[2] ?? join(repoRoot, "scratch", "jfk.wav");
  const speech = isAbsolute(speechArg) ? speechArg : resolve(process.cwd(), speechArg);
  if (!existsSync(speech)) {
    throw new Error(
      `Speech file not found: ${speech}\n` +
        `  curl -L -o scratch/jfk.wav https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav`,
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), "aive-bundled-"));
  const engine = new EditorEngine(dataDir);

  const speechMeta = await probeAsset(speech);
  const dur = Math.min(speechMeta.duration, 15);

  console.log("1. build a test video with real speech (bundled ffmpeg)...");
  const testClip = join(dataDir, "speech.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${dur.toFixed(3)}`,
    "-i", speech,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-y", testClip,
  ]);

  const asset = await engine.importVideo(testClip);
  const clip = engine.appendClip(asset.id);

  console.log("2. transcribe with the BUNDLED whisper-cli + base.en model (offline)...");
  const t0 = Date.now();
  const { cueCount } = await engine.generateCaptions(clip.id, {
    model: "base.en",
    style: { position: "bottom", fontSize: 52, color: "white", box: true },
  });
  console.log(`   ${cueCount} caption cues in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (cueCount === 0) throw new Error("Bundled whisper produced no caption cues");

  console.log("3. export with captions burned in via the BUNDLED font...");
  const out = join(dataDir, "bundled-captions.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  if (!existsSync(out) || statSync(out).size < 1000) throw new Error("export produced no/empty file");
  if (Math.abs(probed.duration - result.duration) > 0.8) {
    throw new Error(`duration drift: ${probed.duration} vs ${result.duration}`);
  }

  console.log("4. confirm the BUNDLED YuNet model loads as a valid ONNX graph...");
  const yunet = await ensureYunetModel(); // honors AIVE_YUNET_MODEL → bundled file
  const ortMod = await import("onnxruntime-node");
  const ort = (ortMod as { default?: typeof ortMod }).default ?? ortMod;
  const session = await ort.InferenceSession.create(yunet);
  if (!session.inputNames.length || !session.outputNames.length) {
    throw new Error("bundled YuNet ONNX has no inputs/outputs");
  }
  console.log(`   YuNet ok: inputs=[${session.inputNames}] outputs=[${session.outputNames.length} tensors]`);

  console.log("\nBUNDLED OFFLINE SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("BUNDLED OFFLINE SMOKE TEST FAILED:", err);
  process.exit(1);
});
