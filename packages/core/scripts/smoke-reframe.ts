/**
 * Phase 3 smoke test: subject-tracking auto-reframe (YuNet, Apache-2.0).
 * Synthesizes a 16:9 clip with a face moving left-to-right, reframes it to 9:16
 * keeping the subject in frame, exports, and then *verifies tracking worked* by
 * re-detecting the face in the 9:16 output and asserting it stays near the
 * horizontal centre (a naive static crop would lose it at the extremes).
 *
 * Run: npx tsx packages/core/scripts/smoke-reframe.ts [face.jpg]
 *   face.jpg is any photo with a clear face; if omitted, one is downloaded.
 *
 * The YuNet model is auto-downloaded on first run (cached under ~/.aive/models;
 * override with AIVE_MODELS_DIR / AIVE_YUNET_MODEL).
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg, FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { FaceDetector } from "../src/reframe/detector.js";
import { execa } from "execa";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const DET = FaceDetector.inputSize;

/** Detect the face centre in a still frame, mapped back to its pixel coords. */
async function faceCenter(framePath: string, w: number, h: number): Promise<{ x: number; y: number } | null> {
  const r = Math.min(DET / w, DET / h);
  const sw = Math.round(w * r);
  const sh = Math.round(h * r);
  const px = Math.floor((DET - sw) / 2);
  const py = Math.floor((DET - sh) / 2);
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-i", framePath, "-vf", `scale=${sw}:${sh},pad=${DET}:${DET}:${px}:${py},format=rgb24`, "-f", "rawvideo", "-"],
    { encoding: "buffer" },
  );
  const det = await FaceDetector.create();
  const faces = await det.detect(new Uint8Array(stdout as Buffer), 0.6);
  if (faces.length === 0) return null;
  const f = faces.sort((a, b) => b.score - a.score)[0];
  return { x: ((f.x + f.w / 2) - px) / r, y: ((f.y + f.h / 2) - py) / r };
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-reframe-"));
  const engine = new EditorEngine(dataDir);

  // Resolve a face image (arg, or download one). Sources can be flaky, so try
  // each in turn and VALIDATE the payload is really a JPEG (magic bytes) —
  // thispersondoesnotexist has been seen returning HTML.
  let face = process.argv[2] ? (isAbsolute(process.argv[2]) ? process.argv[2] : resolve(process.cwd(), process.argv[2])) : "";
  if (!face || !existsSync(face)) {
    face = join(dataDir, "face.jpg");
    console.log("0a. downloading a sample face image...");
    const sources = [
      "https://thispersondoesnotexist.com/",
      // OpenCV's standard sample portrait (contains a clear frontal face).
      "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg",
    ];
    let got = false;
    for (const url of sources) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) continue; // not a JPEG
        await writeFile(face, buf);
        got = true;
        break;
      } catch {
        /* try next source */
      }
    }
    if (!got) throw new Error("could not download a valid face image from any source — pass one: smoke-reframe.ts <face.jpg>");
  }

  console.log("0b. synthesize a 1920x1080 clip with a face sweeping left↔right...");
  const src = join(dataDir, "wide.mp4");
  const dur = 6;
  await runFfmpeg([
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x202830:s=1920x1080:d=${dur}:r=30`,
    "-i",
    face,
    "-filter_complex",
    // 360px face, vertically centred, x oscillates across most of the width.
    `[1:v]scale=360:360[f];[0:v][f]overlay=x='(W-w)*(0.5+0.42*sin(2*PI*t/${dur}))':y=(H-h)/2:eval=frame[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-t",
    String(dur),
    "-y",
    src,
  ]);

  const asset = await engine.importVideo(src);
  console.log(`   source: ${asset.width}x${asset.height} ${asset.duration.toFixed(2)}s`);

  console.log("1. set project to 9:16 (1080x1920) and auto-reframe the clip...");
  engine.setProjectSettings({ width: 1080, height: 1920 });
  const clip = engine.appendClip(asset.id);
  const t0 = Date.now();
  // Responsive settings: the synthetic face sweeps the full width fast, far
  // quicker than real footage, so use a high sample rate + low smoothing lag.
  const r = await engine.autoReframe(clip.id, { sampleFps: 10, smoothing: 0.7 });
  console.log(`   hitRate=${(r.hitRate * 100).toFixed(0)}%  crop=${r.cropWidth}x${r.cropHeight}  keyframes=${r.keyframes}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.hitRate < 0.5) throw new Error(`face was tracked in too few frames (hitRate=${r.hitRate})`);

  console.log("2. export the reframed 9:16 video...");
  const out = join(dataDir, "reframed.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  if (probed.width !== 1080 || probed.height !== 1920) throw new Error(`expected 1080x1920, got ${probed.width}x${probed.height}`);

  console.log("3. verify the subject stays centred in the 9:16 output...");
  // Sample frames at moments when the face is near the LEFT and RIGHT extremes
  // of the original sweep (t≈1.5s and t≈4.5s). A static crop would lose it.
  const checks = [1.5, 3.0, 4.5];
  let centred = 0;
  for (const t of checks) {
    const frame = join(dataDir, `chk_${t}.png`);
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-y", frame]);
    const c = await faceCenter(frame, probed.width, probed.height);
    if (!c) {
      console.log(`   t=${t}s: no face found`);
      continue;
    }
    const frac = c.x / probed.width;
    const ok = frac > 0.2 && frac < 0.8; // within the middle 60%
    console.log(`   t=${t}s: face x=${c.x.toFixed(0)} (${(frac * 100).toFixed(0)}% across) ${ok ? "✓ centred" : "✗ off-centre"}`);
    if (ok) centred++;
  }
  if (centred < 2) throw new Error(`subject was not kept centred (only ${centred}/${checks.length} frames centred)`);

  console.log("\nAUTO-REFRAME SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("AUTO-REFRAME SMOKE TEST FAILED:", err);
  process.exit(1);
});
