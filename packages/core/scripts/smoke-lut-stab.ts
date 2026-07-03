/**
 * Phase 2 smoke test: LUT, crop/reframe, and stabilization (vidstab).
 * Generates an identity .cube LUT, applies it + a crop, stabilizes a clip,
 * and exports — verifying each FFmpeg path actually runs and produces output.
 *
 * Run: npx tsx packages/core/scripts/smoke-lut-stab.ts <clipA> <clipB>
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";

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
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-lut-stab.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-lut-"));
  const engine = new EditorEngine(dataDir);

  // Write an identity LUT (a path with a Windows drive-letter colon to exercise escaping).
  const lutPath = join(dataDir, "identity.cube");
  writeFileSync(lutPath, IDENTITY_CUBE);

  const a = await engine.importVideo(clipA); // 1280x720, 5s
  const b = await engine.importVideo(clipB); // 640x480, 4s
  const c1 = engine.appendClip(a.id);
  const c2 = engine.appendClip(b.id);

  console.log("1. apply LUT + crop to clip 1...");
  engine.setClipEffects(c1.id, { lut: lutPath });
  engine.setClipEffects(c1.id, { crop: { x: 100, y: 50, width: 900, height: 600 } });

  console.log("2. set project to vertical 9:16 (reframe target)...");
  engine.setProjectSettings({ width: 1080, height: 1920 });

  console.log("3. stabilize clip 2 (two-pass vidstab)...");
  const stabilized = await engine.stabilizeClip(c2.id);
  const bakedAsset = engine.getAsset(stabilized.assetId);
  console.log(`   clip 2 now references baked asset: ${bakedAsset.name} (${bakedAsset.duration.toFixed(2)}s)`);
  if (!bakedAsset.name.includes("stabilized")) throw new Error("stabilize did not rewire the clip");

  console.log("4. export...");
  const out = join(dataDir, "lutstab.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect 1080x1920)`);
  if (probed.width !== 1080 || probed.height !== 1920) throw new Error(`wrong output dimensions: ${probed.width}x${probed.height}`);
  if (probed.duration < result.duration - 0.8) throw new Error("export shorter than expected");

  console.log("\nLUT + STAB + REFRAME SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("LUT/STAB SMOKE TEST FAILED:", err);
  process.exit(1);
});
