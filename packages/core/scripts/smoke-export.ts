/**
 * Phase 9 smoke: export presets actually change the encoded container/codec.
 * Exports the same tiny timeline three ways — default mp4/h264, an explicit
 * h265, and the web (webm/vp9) preset — and probes each output to confirm the
 * codec/container really changed. Real FFmpeg.
 *
 * Run: npx tsx packages/core/scripts/smoke-export.ts <clipA>
 */
import { methods } from "../src/rpc.js";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA] = process.argv;
  if (!clipA) throw new Error("usage: smoke-export.ts <clipA>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-export-"));
  const engine = new EditorEngine(dataDir);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  const a = (await call<{ asset: { id: string } }>("import_video", { path: clipA })).asset;
  await call("set_project_settings", { width: 256, height: 144, fps: 24 });
  await call("append_clip", { assetId: a.id, sourceOutFrame: 48 }); // ~2s

  console.log("1. default export (mp4 / h264)...");
  const out1 = join(dataDir, "default.mp4");
  await call("export_video", { outputPath: out1 });
  const p1 = await probeAsset(out1);
  console.log(`   ${p1.videoCodec}`);
  check(/h264|avc/i.test(p1.videoCodec ?? ""), "default is H.264");

  console.log("2. explicit H.265 (mp4 / hevc)...");
  const out2 = join(dataDir, "hevc.mp4");
  await call("export_video", { outputPath: out2, videoCodec: "h265", quality: 30 });
  const p2 = await probeAsset(out2);
  console.log(`   ${p2.videoCodec}`);
  check(/hevc|h265/i.test(p2.videoCodec ?? ""), "H.265 export is HEVC");

  console.log("3. web preset (webm / vp9 / opus)...");
  const out3 = join(dataDir, "web.webm");
  await call("export_video", { outputPath: out3, preset: "web" });
  const p3 = await probeAsset(out3);
  console.log(`   ${p3.videoCodec} / ${p3.audioCodec}`);
  check(/vp9/i.test(p3.videoCodec ?? ""), "web preset is VP9");

  console.log(failures === 0 ? "\nEXPORT SMOKE TEST PASSED" : `\nEXPORT SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("EXPORT SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
