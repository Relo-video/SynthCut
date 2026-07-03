/**
 * P1-B smoke: preview PROXY media. Synthesizes a "4K-ish" source, confirms a
 * low-res proxy is produced and recorded on the asset, that the proxy is
 * smaller than the original, and that EXPORT still renders at the project
 * canvas (i.e. proxies never degrade the final output). Real FFmpeg.
 *
 * Run: npx tsx packages/core/scripts/smoke-proxy.ts
 */
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-proxy-"));
  const engine = new EditorEngine(dataDir);

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  // 1. Synthesize a large (3840-wide) source.
  console.log("1. make a 4K-ish source...");
  const big = join(dataDir, "big.mp4");
  await runFfmpeg([
    "-hide_banner", "-f", "lavfi", "-i", "testsrc=size=3840x2160:rate=10:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-y", big,
  ]);

  // 2. Import — proxy generation kicks off in the background; force-await one.
  console.log("2. import + generate proxy...");
  const a = await engine.importVideo(big);
  check(a.width === 3840 && a.height === 2160, "imported 3840x2160 source");
  const proxied = await engine.generateProxy(a.id);
  check(!!proxied.proxyPath && existsSync(proxied.proxyPath), "proxy file produced + recorded on asset");
  const proxyMeta = await probeAsset(proxied.proxyPath!);
  console.log(`   proxy ${proxyMeta.width}x${proxyMeta.height} (original 3840x2160)`);
  check(proxyMeta.width <= 1280 && proxyMeta.width < a.width, "proxy is low-res (≤1280 long edge)");

  // 3. Export still uses the FULL-RES original (canvas = source here).
  console.log("3. export uses full resolution...");
  engine.appendClip(a.id);
  const out = join(dataDir, "out.mp4");
  await engine.exportVideo(out);
  const exp = await probeAsset(out);
  console.log(`   export ${exp.width}x${exp.height} (expect 3840x2160)`);
  check(exp.width === 3840 && exp.height === 2160, "export rendered at full resolution, not the proxy");

  console.log(failures === 0 ? "\nPROXY SMOKE TEST PASSED" : `\nPROXY SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PROXY SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
