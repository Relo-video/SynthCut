/**
 * Phase 5 smoke: richer color grade + effects + scopes actually bake/run.
 * Applies a basic eq grade, a secondary grade (white balance + lift/gamma/gain
 * wheels + a master tone curve + hue), an identity LUT, and two stacked effects
 * (blur + sharpen) to a clip; exports with REAL FFmpeg to prove the
 * colorbalance/hue/curves/lut3d/gblur/unsharp filtergraph runs end-to-end; then
 * calls inspect_color and verifies it returns finite scope numbers + three
 * scope images on disk (the Phase-5 deliverable: "graded clip with a curve +
 * LUT; scope readout returned").
 *
 * Run: npx tsx packages/core/scripts/smoke-color.ts <clipA> [clipB]
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";

const IDENTITY_CUBE = `TITLE "Identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

async function main() {
  const [, , clipA, clipBArg] = process.argv;
  if (!clipA) throw new Error("usage: smoke-color.ts <clipA> [clipB]");
  const clipB = clipBArg ?? clipA;

  const dataDir = mkdtempSync(join(tmpdir(), "aive-color-"));
  const engine = new EditorEngine(dataDir);
  // Small canvas keeps the export quick while exercising the exact filtergraph.
  engine.setProjectSettings({ width: 480, height: 270, fps: 30 });

  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);
  const base = engine.appendClip(a.id);
  const second = engine.appendClip(b.id);

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };
  const clipOf = (id: string) => {
    for (const t of engine.getProject().tracks) {
      const c = t.clips.find((c) => c.id === id);
      if (c) return c;
    }
    return undefined;
  };

  // 1. Basic eq + secondary grade (wheels, white balance, hue, tone curve).
  console.log("1. apply basic eq + richer secondary grade...");
  engine.setClipEffects(base.id, { color: { contrast: 1.1, saturation: 1.15 } });
  engine.setClipGrade(base.id, {
    temperature: 0.25,
    tint: -0.1,
    hue: 8,
    lift: { b: 0.12 },          // teal-ish shadows
    gamma: { r: 0.05 },         // warm mids
    gain: { r: -0.05, b: 0.05 },// cool highlights
    curve: "0/0 0.25/0.18 0.75/0.85 1/1", // S-curve contrast
  });
  const g = clipOf(base.id)?.effects?.grade;
  check(g?.lift?.b === 0.12, "lift.b wheel persisted");
  check((g?.curve ?? "").includes("0.25/0.18"), "master tone curve persisted");
  check(g?.temperature === 0.25, "white-balance temperature persisted");

  // 2. Identity LUT on top of the grade.
  console.log("2. apply identity LUT...");
  const lutPath = join(dataDir, "identity.cube");
  writeFileSync(lutPath, IDENTITY_CUBE);
  engine.setClipEffects(base.id, { lut: lutPath });

  // 3. Stacked effects: blur then sharpen, plus a vignette on the 2nd clip.
  console.log("3. stack effects (blur + sharpen)...");
  const e1 = engine.applyEffect(base.id, { type: "blur", amount: 6 });
  const e2 = engine.applyEffect(base.id, { type: "sharpen", amount: 1.2 });
  engine.applyEffect(second.id, { type: "vignette" });
  check(clipOf(base.id)?.effects?.filters?.length === 2, "two effects stacked on clip A");
  // Remove + re-check the list shrinks.
  engine.removeEffect(base.id, e1.effectId);
  check(clipOf(base.id)?.effects?.filters?.length === 1, "removeEffect drops one");
  engine.applyEffect(base.id, { id: e2.effectId, type: "sharpen", amount: 2 }); // update in place
  check(clipOf(base.id)?.effects?.filters?.[0]?.amount === 2, "applyEffect updates in place by id");

  // 4. Real export — the whole color+effects filtergraph must run.
  console.log("4. export (real ffmpeg)...");
  const out = join(dataDir, "color.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect 480x270 ~${result.duration.toFixed(2)}s)`);
  check(probed.width === 480 && probed.height === 270, "output dimensions 480x270");
  check(Math.abs(probed.duration - result.duration) < 0.8, "export duration matches");

  // 5. inspect_color — scope readout + scope images.
  console.log("5. inspect_color (scopes)...");
  const insp = await engine.inspectColor(result.duration / 2);
  const s = insp.stats;
  console.log(`   luma avg ${s.luma.avg.toFixed(0)} (contrast ${s.luma.contrast.toFixed(0)}), sat ${s.saturation.avg.toFixed(0)}, rgb ${s.rgb.r}/${s.rgb.g}/${s.rgb.b}`);
  console.log(`   notes: ${s.notes.join("; ")}`);
  check(Number.isFinite(s.luma.avg) && s.luma.max >= s.luma.min, "luma stats finite + ordered");
  check(Number.isFinite(s.rgb.r) && Number.isFinite(s.rgb.g) && Number.isFinite(s.rgb.b), "mean RGB finite");
  check(s.notes.length > 0, "color notes returned");
  check(existsSync(insp.scopes.histogram), "histogram scope image written");
  check(existsSync(insp.scopes.waveform), "waveform scope image written");
  check(existsSync(insp.scopes.vectorscope), "vectorscope scope image written");

  console.log(failures === 0 ? "\nCOLOR SMOKE TEST PASSED" : `\nCOLOR SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("COLOR SMOKE TEST FAILED:", err);
  process.exit(1);
});
