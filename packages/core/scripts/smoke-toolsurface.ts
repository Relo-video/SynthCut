/**
 * Phase 7 deliverable: the AI-facing RPC SURFACE is sufficient to build a
 * multi-track, layered, KEYFRAMED edit end-to-end — driven the same way the AI
 * drives it (validate params with each tool's schema, then call its handler).
 * Nothing here touches the engine directly; every step is a tool call.
 *
 * Run: npx tsx packages/core/scripts/smoke-toolsurface.ts <clipA> <clipB>
 */
import { methods } from "../src/rpc.js";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-toolsurface.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-surface-"));
  const engine = new EditorEngine(dataDir);

  // Dispatch exactly like the server: schema-validate, then run the handler.
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

  console.log("1. import + canvas (tools)...");
  const a = (await call<{ asset: { id: string } }>("import_video", { path: clipA })).asset;
  const b = (await call<{ asset: { id: string } }>("import_video", { path: clipB })).asset;
  await call("set_project_settings", { width: 360, height: 640, fps: 30 });

  console.log("2. base layer + a second video track on top...");
  const base = await call<{ clip: { id: string } }>("append_clip", { assetId: a.id });
  const vTop = await call<{ trackIndex: number }>("add_track", { kind: "video" });
  check(vTop.trackIndex >= 1, "second video track created above base");
  const over = await call<{ clip: { id: string } }>("add_clip", {
    assetId: b.id, trackIndex: vTop.trackIndex, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60,
  });

  console.log("3. transform + keyframe the overlay (PiP fly-in)...");
  await call("set_clip_transform", { clipId: over.clip.id, scale: 0.45, x: 0.25, y: -0.25 });
  await call("set_keyframes", { clipId: over.clip.id, property: "x", keyframes: [
    { frame: 0, value: -0.6 }, { frame: 15, value: 0.25, ease: "easeOut" },
  ] });
  await call("set_keyframes", { clipId: over.clip.id, property: "opacity", keyframes: [
    { frame: 0, value: 0 }, { frame: 12, value: 1 },
  ] });

  console.log("4. grade + effect + text (tools)...");
  await call("color_grade", { clipId: base.clip.id, contrast: 1.1, saturation: 1.15 });
  await call("apply_color", { clipId: base.clip.id, temperature: 0.2, curve: "0/0 0.25/0.18 0.75/0.85 1/1" });
  const fx = await call<{ effectId: string }>("apply_effect", { clipId: base.clip.id, type: "sharpen", amount: 1 });
  check(typeof fx.effectId === "string" && fx.effectId.length > 0, "apply_effect returns an effectId");
  await call("add_text", { clipId: base.clip.id, text: "LAYERED", position: "bottom" });

  console.log("5. inspect_timeline (vision loop: structure + frame)...");
  const insp = await call<{ summary: { trackCount: number }; frame: string }>("inspect_timeline", {});
  check(insp.summary.trackCount === 2, "summary reports 2 tracks");
  check(existsSync(insp.frame), "inspect_timeline rendered a frame image");

  console.log("6. export (real ffmpeg, via tool)...");
  const out = join(dataDir, "surface.mp4");
  const exp = await call<{ path: string; duration: number }>("export_video", { outputPath: out });
  const probed = await probeAsset(exp.path);
  console.log(`   exported ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  check(probed.width === 360 && probed.height === 640, "export dimensions 360x640");

  console.log(failures === 0 ? "\nTOOL-SURFACE SMOKE TEST PASSED" : `\nTOOL-SURFACE SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("TOOL-SURFACE SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
