/**
 * SOTA Phase 1 deliverable: the local platform is safe to expose.
 *  - /rpc without the session token → 401; with it → ok.
 *  - /health without the token → liveness only (no ffmpeg banner / revision).
 *  - /file refuses arbitrary disk paths (403 even WITH a valid token) and
 *    serves only data-dir artifacts + imported asset files.
 *  - WebSocket upgrade without the token → connection refused.
 *
 * Run: npx tsx packages/core/scripts/smoke-security.ts
 * (No media arguments needed — synthesizes its own clip with ffmpeg lavfi.)
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-security-"));
  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port: 0, dataDir });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;

  // The published discovery file must carry the token clients need.
  const info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { port: number; token: string };
  const token = info.token;

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. token discovery...");
  check(typeof token === "string" && token.length >= 24, "server.json publishes a token");
  check(info.port === port, "server.json publishes the bound port");

  console.log("2. /rpc auth...");
  const rpcNoToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcNoToken.status === 401, `/rpc without token → 401 (got ${rpcNoToken.status})`);
  const noTokenBody = (await rpcNoToken.json()) as { error?: string };
  check(/x-aive-token/.test(noTokenBody.error ?? ""), "401 error teaches how to authenticate");

  const rpcWithToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": token },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcWithToken.status === 200, `/rpc with token → 200 (got ${rpcWithToken.status})`);

  const rpcBadToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": "wrong-token" },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcBadToken.status === 401, `/rpc with WRONG token → 401 (got ${rpcBadToken.status})`);

  console.log("3. /health redaction...");
  const healthAnon = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
  check(healthAnon.ok === true, "/health stays reachable without a token (liveness)");
  check(!("ffmpeg" in healthAnon) && !("revision" in healthAnon), "unauthenticated /health hides internals");
  const healthAuthed = (await (
    await fetch(`${base}/health`, { headers: { "x-aive-token": token } })
  ).json()) as Record<string, unknown>;
  check("revision" in healthAuthed, "authenticated /health includes internals");

  console.log("4. /file allowlist (synthesizing a clip with ffmpeg)...");
  const clipPath = join(dataDir, "..", `aive-sec-clip-${Date.now()}.mp4`);
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
    "-pix_fmt", "yuv420p", "-y", clipPath,
  ]);

  // Not imported, outside dataDir → forbidden even with a valid token.
  const fileForbidden = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}&token=${token}`);
  check(fileForbidden.status === 403, `/file for a non-imported path → 403 (got ${fileForbidden.status})`);

  // A random system file: also forbidden.
  const sysPath = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hosts";
  const fileSystem = await fetch(`${base}/file?path=${encodeURIComponent(sysPath)}&token=${token}`);
  check(fileSystem.status === 403, `/file for ${sysPath} → 403 (got ${fileSystem.status})`);

  // Traversal from inside the data dir must not escape it.
  const traversal = join(dataDir, "previews", "..", "..", "server-escape.txt");
  const fileTraversal = await fetch(`${base}/file?path=${encodeURIComponent(traversal)}&token=${token}`);
  check(fileTraversal.status === 403, `/file with ..-traversal outside dataDir → 403 (got ${fileTraversal.status})`);

  // After import the SAME file becomes servable (and still requires the token).
  await engine.importVideo(clipPath);
  const fileOk = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}&token=${token}`);
  check(fileOk.status === 200, `/file for an IMPORTED asset → 200 (got ${fileOk.status})`);
  const fileNoToken = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}`);
  check(fileNoToken.status === 401, `/file without token → 401 (got ${fileNoToken.status})`);

  console.log("5. WebSocket upgrade auth...");
  const wsDenied = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(false); });
    ws.on("error", () => { clearTimeout(timer); resolve(true); });
  });
  check(wsDenied, "WS upgrade without token is refused");

  const wsAllowed = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(true); });
    ws.on("error", () => { clearTimeout(timer); resolve(false); });
  });
  check(wsAllowed, "WS upgrade with token connects");

  await server.stop();
  console.log(failures === 0 ? "\nSECURITY SMOKE TEST PASSED" : `\nSECURITY SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SECURITY SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
