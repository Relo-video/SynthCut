/**
 * SOTA Phase 5 deliverable: adjustment layers. A grayscale adjustment layer
 * placed over the middle of a red clip must desaturate the export INSIDE its
 * window and leave the picture untouched OUTSIDE it. Also checks that source
 * tools refuse an adjustment clip with a teaching error.
 *
 * Run: npx tsx packages/core/scripts/smoke-adjustment.ts
 * (Self-contained — synthesizes a red clip with ffmpeg lavfi.)
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg, runFfmpegStdoutBuffer } from "../src/ffmpeg/executor.js";

async function meanRgb(path: string, t: number): Promise<[number, number, number]> {
  const buf = await runFfmpegStdoutBuffer([
    "-hide_banner", "-ss", t.toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  return [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0];
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-adj-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 320, height: 180, fps: 30 });

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

  console.log("1. red clip + grayscale adjustment layer over its middle...");
  const src = join(dataDir, "red.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "color=c=red:s=320x180:d=6:r=30",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", src,
  ]);
  const { asset } = await call<{ asset: { id: string } }>("import_video", { path: src });
  await call("append_clip", { assetId: asset.id });
  const vTop = await call<{ trackIndex: number }>("add_track", { kind: "video" });

  // Adjustment window covers 2s..4s of the 6s clip.
  const adj = await call<{ clip: { id: string; adjustment?: boolean } }>("add_adjustment_clip", {
    trackIndex: vTop.trackIndex,
    startFrame: 60,
    durationFrames: 60,
  });
  check(!!adj.clip.adjustment, "adjustment clip created");
  await call("apply_effect", { clipId: adj.clip.id, type: "grayscale" });

  console.log("2. export and sample inside/outside the window...");
  const out = join(dataDir, "adj.mp4");
  await call("export_video", { outputPath: out });

  const sat = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b);
  const before = await meanRgb(out, 1.0);   // outside (before window)
  const inside = await meanRgb(out, 3.0);   // inside the window
  const after = await meanRgb(out, 5.0);    // outside (after window)
  console.log(`   before(${before}) inside(${inside}) after(${after})`);
  check(sat(before) > 60, `red is saturated before the window (spread ${sat(before)})`);
  check(sat(inside) < 12, `grayscale inside the window (spread ${sat(inside)})`);
  check(sat(after) > 60, `red is saturated after the window (spread ${sat(after)})`);
  // Grayscale keeps luma — the gray must still be bright, not black (i.e. the
  // adjustment filtered the composite rather than replacing it).
  check(inside[0] > 40, `adjusted region keeps the picture's luma (r=${inside[0]})`);

  console.log("3. a color grade on the adjustment layer also bakes...");
  await call("color_grade", { clipId: adj.clip.id, brightness: 0.3 });
  const out2 = join(dataDir, "adj2.mp4");
  await call("export_video", { outputPath: out2 });
  const inside2 = await meanRgb(out2, 3.0);
  check(inside2[0] > inside[0] + 20, `brightness lift visible inside the window (${inside[0]} → ${inside2[0]})`);

  console.log("4. source tools teach when pointed at an adjustment clip...");
  let taught = false;
  try {
    await call("generate_captions", { clipId: adj.clip.id });
  } catch (err) {
    taught = /ADJUSTMENT/i.test(err instanceof Error ? err.message : "");
  }
  check(taught, "generate_captions on an adjustment clip explains itself");

  console.log(failures === 0 ? "\nADJUSTMENT SMOKE TEST PASSED" : `\nADJUSTMENT SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("ADJUSTMENT SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
