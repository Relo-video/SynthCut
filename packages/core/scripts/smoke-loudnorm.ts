/**
 * SOTA Phase 5 deliverable: loudness normalization on export.
 *  - A deliberately QUIET timeline exported with the `social` preset must land
 *    within ±1.5 LU of -14 LUFS integrated (measured with ebur128 — which logs
 *    to STDERR, the same gotcha as signalstats/inspect_color).
 *  - The `master` preset leaves loudness untouched (stays quiet).
 *
 * Run: npx tsx packages/core/scripts/smoke-loudnorm.ts
 * (Self-contained — synthesizes a quiet tone clip with ffmpeg lavfi.)
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg, runFfmpegCaptureStderr } from "../src/ffmpeg/executor.js";

/** Integrated loudness (LUFS) of a file, via ebur128 (logs to stderr). */
async function integratedLufs(path: string): Promise<number> {
  const stderr = await runFfmpegCaptureStderr([
    "-hide_banner", "-i", path, "-af", "ebur128", "-f", "null", "-",
  ]);
  // The summary block ends with "I:  -xx.x LUFS".
  const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  if (!matches.length) throw new Error(`ebur128 produced no integrated loudness. stderr tail: ${stderr.slice(-400)}`);
  return Number(matches[matches.length - 1][1]);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-loud-"));
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

  console.log("1. synthesize a QUIET (-35dB) tone clip...");
  const src = join(dataDir, "quiet.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-af", "volume=-35dB",
    "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", src,
  ]);
  const { asset } = await call<{ asset: { id: string } }>("import_video", { path: src });
  await call("append_clip", { assetId: asset.id });

  console.log("2. export with the social preset (-14 LUFS target)...");
  const social = join(dataDir, "social.mp4");
  await call("export_video", { outputPath: social, preset: "social" });
  const lufsSocial = await integratedLufs(social);
  console.log(`   measured integrated loudness: ${lufsSocial.toFixed(1)} LUFS`);
  check(Math.abs(lufsSocial - -14) <= 1.5, `social export within ±1.5 LU of -14 (got ${lufsSocial.toFixed(1)})`);

  console.log("3. master preset leaves the quiet mix untouched...");
  const master = join(dataDir, "master.mov");
  await call("export_video", { outputPath: master, preset: "master" });
  const lufsMaster = await integratedLufs(master);
  console.log(`   measured integrated loudness: ${lufsMaster.toFixed(1)} LUFS`);
  check(lufsMaster < -25, `master export stays quiet / unnormalized (got ${lufsMaster.toFixed(1)})`);

  console.log("4. explicit loudnessTarget override...");
  const custom = join(dataDir, "custom.mp4");
  await call("export_video", { outputPath: custom, loudnessTarget: -20 });
  const lufsCustom = await integratedLufs(custom);
  console.log(`   measured integrated loudness: ${lufsCustom.toFixed(1)} LUFS`);
  check(Math.abs(lufsCustom - -20) <= 1.5, `custom -20 LUFS target honored (got ${lufsCustom.toFixed(1)})`);

  console.log(failures === 0 ? "\nLOUDNORM SMOKE TEST PASSED" : `\nLOUDNORM SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("LOUDNORM SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
