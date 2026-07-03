/**
 * Phase 8 smoke: native keyframe-animated TEXT bakes into the export (the thing
 * palmier-pro had and we lacked), alongside our coded motion graphics. Adds a
 * title overlay, animates its x (fly-in) + opacity (fade), and exports with real
 * FFmpeg — proving the drawtext x/alpha time-expressions run. A coexisting coded
 * Remotion graphic is attempted opportunistically (skipped if bundling is slow/
 * unavailable; it's already covered by smoke-motion).
 *
 * Run: npx tsx packages/core/scripts/smoke-animtext.ts <clipA>
 */
import { methods } from "../src/rpc.js";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA] = process.argv;
  if (!clipA) throw new Error("usage: smoke-animtext.ts <clipA>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-animtext-"));
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
  await call("set_project_settings", { width: 360, height: 640, fps: 30 });
  const base = await call<{ clip: { id: string } }>("append_clip", { assetId: a.id });

  console.log("1. add a title overlay, then animate it (fly-in + fade)...");
  const ov = await call<{ overlay: { id: string } }>("add_text", { clipId: base.clip.id, text: "ANIMATED TITLE", position: "center", fontSize: 56, box: false, outlineColor: "black", outlineWidth: 3 });
  await call("animate_text", { clipId: base.clip.id, overlayId: ov.overlay.id, property: "x", keyframes: [
    { frame: 0, value: -0.2 }, { frame: 15, value: 0.5, ease: "easeOut" },
  ] });
  await call("animate_text", { clipId: base.clip.id, overlayId: ov.overlay.id, property: "opacity", keyframes: [
    { frame: 0, value: 0 }, { frame: 12, value: 1, ease: "easeIn" },
  ] });

  // The overlay now carries two keyframe tracks.
  const proj = engine.getProject();
  const stored = proj.tracks.flatMap((t) => t.clips).find((c) => c.id === base.clip.id)?.overlays?.[0];
  check(!!stored?.keyframes?.x?.length, "x keyframe track stored on overlay");
  check(!!stored?.keyframes?.opacity?.length, "opacity keyframe track stored on overlay");
  check(stored?.keyframes?.x?.[1]?.ease === "easeOut", "ease preserved on keyframe");

  console.log("2. export (real ffmpeg — drawtext x/alpha exprs must run)...");
  const out = join(dataDir, "animtext.mp4");
  const exp = await call<{ path: string; duration: number }>("export_video", { outputPath: out });
  const probed = await probeAsset(exp.path);
  console.log(`   exported ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  check(probed.width === 360 && probed.height === 640, "animated-text export dimensions 360x640");
  check(probed.duration > 0, "export has content");

  // Opportunistic: a coded motion graphic coexisting on the timeline.
  try {
    console.log("3. coded motion graphic coexisting (optional, Remotion)...");
    const g = await call<{ graphicId?: string }>("add_graphic", { clipId: base.clip.id, template: "title", props: { title: "Coded", subtitle: "graphic" }, startFrame: 0, endFrame: 90 });
    check(!!g.graphicId, "coded graphic added alongside the animated title");
  } catch (e) {
    console.log(`   (skipped: ${(e as Error).message.split("\n")[0]})`);
  }

  console.log(failures === 0 ? "\nANIM-TEXT SMOKE TEST PASSED" : `\nANIM-TEXT SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("ANIM-TEXT SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
