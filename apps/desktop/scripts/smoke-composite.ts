// Phase 2 smoke: the pure compositor plan (no DOM, no FFmpeg). Builds a
// synthetic multi-track project and asserts that activeLayersAt() returns the
// right layers, in z-order, with the right source times / opacities, that gaps
// draw nothing, that transitions cross-fade, that hidden tracks aren't drawn
// (but still play audio), and that muted tracks are silent.
//
// Run:  npx tsx apps/desktop/scripts/smoke-composite.ts

import { activeLayersAt, timelineDurationSec } from "../src/composite";
import type { Clip, MediaAsset, Project, Track } from "../src/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function near(a: number, b: number, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

const FPS = 30;

function asset(id: string, opts: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, path: `C:/media/${id}.mp4`, name: `${id}.mp4`, duration: 100,
    width: 1920, height: 1080, fps: FPS, hasVideo: true, hasAudio: true, addedAt: 0,
    ...opts,
  };
}
function clip(id: string, assetId: string, startFrame: number, dur: number, extra: Partial<Clip> = {}): Clip {
  return { id, assetId, startFrame, sourceInFrame: 0, sourceOutFrame: dur, ...extra };
}
function track(kind: Track["kind"], index: number, clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id: `tr-${kind}-${index}`, kind, index, clips, ...extra };
}

const vidA = asset("vidA");
const vidB = asset("vidB");
const ovl = asset("ovl");
const hid = asset("hid", { hasAudio: false }); // hidden track, video-only (keeps audio test clean)
const aud = asset("aud", { hasVideo: false });
const audMute = asset("audMute", { hasVideo: false });
const music = asset("music", { hasVideo: false, duration: 30 });

const project: Project = {
  id: "p", name: "smoke", width: 1920, height: 1080, fps: FPS,
  assets: [vidA, vidB, ovl, hid, aud, audMute, music],
  tracks: [
    // Base video: A 0..60, B 45..105 (B has a fade transition → overlap [45,60)),
    // then C 120..150 (gap [105,120) before it).
    track("video", 0, [
      clip("A", "vidA", 0, 60),
      clip("B", "vidB", 45, 60, { transition: { type: "fade", durationFrames: 15 } }),
      clip("C", "vidA", 120, 30),
    ]),
    // Upper video overlay: OVL 30..45, fades in over 10 frames (z-order test).
    track("video", 1, [clip("O", "ovl", 30, 15, { effects: { fadeInFrames: 10 } })]),
    // Hidden video track: should never draw, but its audio... is video-only here.
    track("video", 2, [clip("H", "hid", 0, 60)], { hidden: true }),
    // Audio track: AUD 0..90 (unmuted) — should be audible.
    track("audio", 0, [clip("AUD", "aud", 0, 90)]),
    // Muted audio track: should be silent.
    track("audio", 1, [clip("MUTE", "audMute", 0, 90)], { muted: true }),
  ],
  music: { assetId: "music", volume: 0.5 },
  revision: 1, schemaVersion: 2, createdAt: 0, updatedAt: 0,
};

const assetById = new Map(project.assets.map((a) => [a.id, a]));
const at = (frame: number) => activeLayersAt(project, assetById, frame / FPS);

console.log("Phase 2 compositor plan smoke\n");

// --- frame 10: only base A is drawn (upper/hidden not active) ---------------
{
  const plan = at(10);
  const draws = plan.clips.filter((c) => c.draw);
  check("f10: exactly one drawn layer (base A)", draws.length === 1 && draws[0].clipId === "A",
    `got [${draws.map((d) => d.clipId).join(",")}]`);
  // srcTime of A at 10 frames = 10/30 s
  check("f10: A srcTime ≈ 0.333s", !!draws[0] && near(draws[0].srcTime, 10 / FPS));
  // Audio: base A (hasAudio) + audio-track AUD; muted track excluded.
  const audIds = plan.clips.filter((c) => c.audio).map((c) => c.clipId).sort();
  check("f10: audible = A + AUD (muted excluded)", JSON.stringify(audIds) === JSON.stringify(["A", "AUD"]),
    `got [${audIds.join(",")}]`);
  check("f10: muted track clip not audible", !plan.clips.some((c) => c.clipId === "MUTE" && c.audio));
  check("f10: hidden track clip not drawn", !plan.clips.some((c) => c.clipId === "H" && c.draw));
}

// --- frame 35: base A under upper OVL (z-order + fade-in opacity) ------------
{
  const plan = at(35);
  const draws = plan.clips.filter((c) => c.draw);
  check("f35: two drawn layers", draws.length === 2, `got ${draws.length}`);
  check("f35: bottom→top order = [A, O]",
    draws[0]?.clipId === "A" && draws[1]?.clipId === "O",
    `got [${draws.map((d) => d.clipId).join(",")}]`);
  check("f35: base track below overlay track",
    !!draws[0] && !!draws[1] && draws[0].trackIndex < draws[1].trackIndex);
  // OVL local frame = (35-30)=5; fadeIn 10 → opacity ~0.5
  const o = draws.find((d) => d.clipId === "O");
  check("f35: overlay fade-in opacity ≈ 0.5", !!o && near(o.draw!.opacity, 0.5, 0.05),
    `got ${o?.draw?.opacity}`);
}

// --- frame 52: transition cross-fade between A (out) and B (in) on base ------
{
  const plan = at(52);
  const draws = plan.clips.filter((c) => c.draw);
  check("f52: two base layers in overlap", draws.length === 2 &&
    draws.every((d) => d.trackIndex === 0), `got [${draws.map((d) => d.clipId).join(",")}]`);
  const a = draws.find((d) => d.clipId === "A");
  const b = draws.find((d) => d.clipId === "B");
  // prog = (52-45)/(60-45) = 0.4667 → B in, A out
  check("f52: incoming B opacity ≈ 0.467", !!b && near(b.draw!.opacity, 0.4667, 0.03), `got ${b?.draw?.opacity}`);
  check("f52: outgoing A opacity ≈ 0.533", !!a && near(a.draw!.opacity, 0.5333, 0.03), `got ${a?.draw?.opacity}`);
  check("f52: incoming drawn on top of outgoing", draws[0]?.clipId === "A" && draws[1]?.clipId === "B");
}

// --- frame 112: gap on every track → nothing drawn or heard -----------------
{
  const plan = at(112);
  check("f112: gap yields no layers at all", plan.clips.length === 0, `got ${plan.clips.length}`);
}

// --- timeline duration = furthest end (C ends at frame 150) -----------------
check("duration = 5.0s (C ends @150)", near(timelineDurationSec(project), 150 / FPS), `got ${timelineDurationSec(project)}`);

// --- transform + keyframe animation surfaces in the draw plan ----------------
{
  const tfProject: Project = {
    ...project,
    tracks: [
      track("video", 0, [
        clip("TF", "vidA", 0, 60, {
          effects: { transform: { rotation: 8, flipH: true } },
          keyframes: {
            x: [{ frame: 0, value: -0.5 }, { frame: 15, value: 0, ease: "easeOut" }],
            scale: [{ frame: 0, value: 0.5 }, { frame: 10, value: 1 }],
            opacity: [{ frame: 0, value: 0 }, { frame: 5, value: 1 }],
          },
        }),
      ]),
    ],
    music: undefined,
  };
  const tfAssets = new Map(tfProject.assets.map((a) => [a.id, a]));
  const drawAt = (frame: number) => activeLayersAt(tfProject, tfAssets, frame / FPS).clips[0]?.draw;

  const d0 = drawAt(0)!;
  check("tf @0: x = -0.5", !!d0 && near(d0.transform.x, -0.5));
  check("tf @0: scale = 0.5", !!d0 && near(d0.transform.scale, 0.5));
  check("tf @0: static rotation 8 + flipH", !!d0 && d0.transform.rotation === 8 && d0.transform.flipH === true);
  check("tf @0: opacity keyframed to 0", !!d0 && near(d0.transform.opacity, 0) && near(d0.opacity, 0));

  const d5 = drawAt(5)!;
  check("tf @5: scale halfway = 0.75", !!d5 && near(d5.transform.scale, 0.75));
  check("tf @5: opacity ramped to 1", !!d5 && near(d5.opacity, 1));

  const d15 = drawAt(15)!;
  check("tf @15: x eased to 0", !!d15 && near(d15.transform.x, 0));
  check("tf @20: scale clamps after last kf", near(drawAt(20)!.transform.scale, 1));
}

console.log(failures === 0 ? "\nPASS — all checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
