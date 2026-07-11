/**
 * SOTA Phase 6 deliverable: OpenTimelineIO interop.
 *  - A 2-track timeline with a transition, effects, keyframes, text, markers
 *    and music exports to a valid OTIO Timeline.1 JSON.
 *  - Importing that file back restores an EQUIVALENT project (lossless
 *    round-trip through metadata.synthcut): normalized deep-equal.
 *  - A foreign-shaped OTIO (no synthcut metadata) still imports structurally.
 *  - Missing media becomes offline placeholder assets (missing: true).
 *
 * Run: npx tsx packages/core/scripts/smoke-otio.ts
 * (Self-contained — synthesizes media with ffmpeg lavfi.)
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import type { Project } from "../src/types.js";

/** The project reduced to the fields that define the edit (order-stable). */
function normalize(p: Project) {
  return {
    canvas: { w: p.width, h: p.height, fps: p.fps },
    markers: p.markers ?? [],
    music: p.music ?? null,
    assets: [...p.assets]
      .map((a) => ({ id: a.id, path: a.path.toLowerCase(), name: a.name, duration: a.duration }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tracks: [...p.tracks]
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        index: t.index,
        kind: t.kind,
        muted: t.muted ?? false,
        clips: t.clips.map((c) => ({
          id: c.id,
          assetId: c.assetId ?? null,
          adjustment: c.adjustment ?? false,
          startFrame: c.startFrame,
          sourceInFrame: c.sourceInFrame,
          sourceOutFrame: c.sourceOutFrame,
          effects: c.effects ?? null,
          transition: c.transition ?? null,
          overlays: c.overlays ?? null,
          keyframes: c.keyframes ?? null,
        })),
      })),
  };
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-otio-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 640, height: 360, fps: 30 });

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

  console.log("1. build a 2-track timeline with transition + effects + music...");
  const mediaA = join(dataDir, "a.mp4");
  const mediaB = join(dataDir, "b.mp4");
  const musicPath = join(dataDir, "music.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-y", mediaA]);
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-shortest", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-y", mediaB]);
  await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=10", "-y", musicPath]);

  const a = (await call<{ asset: { id: string } }>("import_video", { path: mediaA })).asset;
  const b = (await call<{ asset: { id: string } }>("import_video", { path: mediaB })).asset;
  const music = (await call<{ asset: { id: string } }>("import_video", { path: musicPath })).asset;

  const c1 = (await call<{ clip: { id: string } }>("append_clip", { assetId: a.id })).clip;
  const c2 = (await call<{ clip: { id: string } }>("append_clip", { assetId: b.id })).clip;
  await call("set_transition", { clipId: c2.id, type: "dissolve", durationFrames: 20 });
  await call("color_grade", { clipId: c1.id, saturation: 1.4, contrast: 1.1 });
  await call("apply_effect", { clipId: c1.id, type: "vignette" });
  await call("set_clip_speed", { clipId: c2.id, speed: 1.5 });
  const vTop = await call<{ trackIndex: number }>("add_track", { kind: "video" });
  const over = (await call<{ clip: { id: string } }>("add_clip", { assetId: b.id, trackIndex: vTop.trackIndex, startFrame: 30, sourceInFrame: 0, sourceOutFrame: 45 })).clip;
  await call("set_clip_transform", { clipId: over.id, scale: 0.4, x: 0.25, y: -0.2 });
  await call("set_keyframes", { clipId: over.id, property: "x", keyframes: [{ frame: 0, value: -0.4 }, { frame: 15, value: 0.25, ease: "easeOut" }] });
  await call("add_text", { clipId: c1.id, text: "OTIO round trip", position: "top" });
  const aTrack = await call<{ trackIndex: number }>("add_track", { kind: "audio" });
  await call("add_clip", { assetId: a.id, trackIndex: aTrack.trackIndex, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60 });
  await call("set_music", { assetId: music.id, volume: 0.25, duck: true });
  await call("set_markers", { frames: [{ frame: 45, name: "Handoff", note: "grade from here" }] });

  const before = normalize(engine.getProject());

  console.log("2. export_otio → valid Timeline.1 JSON...");
  const otioPath = join(dataDir, "handoff.otio");
  const exp = await call<{ path: string; clipCount: number }>("export_otio", { path: otioPath });
  const doc = JSON.parse(readFileSync(exp.path, "utf8"));
  check(doc.OTIO_SCHEMA === "Timeline.1", "root is Timeline.1");
  check(doc.tracks.OTIO_SCHEMA === "Stack.1", "tracks is a Stack.1");
  const trackKinds = doc.tracks.children.map((t: { kind: string }) => t.kind);
  check(trackKinds.includes("Video") && trackKinds.includes("Audio"), `stack carries Video + Audio tracks (${trackKinds.join(",")})`);
  const hasTransition = doc.tracks.children.some((t: { children: { OTIO_SCHEMA: string }[] }) =>
    t.children.some((c) => c.OTIO_SCHEMA === "Transition.1"));
  check(hasTransition, "transition serialized as Transition.1");
  const hasGap = doc.tracks.children.some((t: { children: { OTIO_SCHEMA: string }[] }) =>
    t.children.some((c) => c.OTIO_SCHEMA === "Gap.1"));
  check(hasGap, "positional gap serialized as Gap.1 (overlay starts at frame 30)");

  console.log("3. import_otio → lossless round-trip...");
  const imp = await call<{ warnings: string[]; missing: string[] }>("import_otio", { path: otioPath });
  check(imp.warnings.length === 0, `no warnings (${imp.warnings.join("; ") || "none"})`);
  check(imp.missing.length === 0, "no missing media");
  const after = normalize(engine.getProject());
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (!same) {
    console.log("   BEFORE:", JSON.stringify(before).slice(0, 400));
    console.log("   AFTER: ", JSON.stringify(after).slice(0, 400));
  }
  check(same, "normalized projects deep-equal after round-trip");

  console.log("4. foreign OTIO (no synthcut metadata) imports structurally...");
  const foreign = {
    OTIO_SCHEMA: "Timeline.1",
    name: "Foreign cut",
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          kind: "Video",
          name: "V1",
          children: [
            {
              OTIO_SCHEMA: "Clip.2",
              name: "shot 1",
              source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 0 }, duration: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 60 } },
              media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: mediaA } },
              active_media_reference_key: "DEFAULT_MEDIA",
            },
            {
              OTIO_SCHEMA: "Clip.2",
              name: "missing shot",
              source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 0 }, duration: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 45 } },
              media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: join(dataDir, "does-not-exist.mov") } },
              active_media_reference_key: "DEFAULT_MEDIA",
            },
          ],
        },
      ],
    },
  };
  const foreignPath = join(dataDir, "foreign.otio");
  writeFileSync(foreignPath, JSON.stringify(foreign), "utf8");
  const fimp = await call<{ missing: string[]; project: Project }>("import_otio", { path: foreignPath });
  check(fimp.missing.length === 1, `missing media reported (${fimp.missing.length})`);
  const fp = engine.getProject();
  const fclips = fp.tracks.find((t) => t.kind === "video")!.clips;
  check(fclips.length === 2, "both foreign clips placed");
  check(fclips[1].startFrame === 60, `sequential placement (second clip at frame 60, got ${fclips[1].startFrame})`);
  check(fp.assets.some((x) => x.missing), "offline placeholder asset flagged missing:true");

  console.log(failures === 0 ? "\nOTIO SMOKE TEST PASSED" : `\nOTIO SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("OTIO SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
