// Discovers or launches the editor core, and — crucially — **reuses an already
// running core** when one exists. This is what lets the desktop app and an AI
// client (via the MCP server) share ONE live editing session: whoever starts
// first launches the core; the other attaches to it. They must agree on the
// data directory (where the core publishes server.json), so we use the same
// default the core and MCP server use: ~/.aive/data.
//
// Electron-free on purpose, so it can be tested under plain Node.
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const require_ = createRequire(__filename);

function getDataDir() {
  return process.env.AIVE_DATA_DIR || path.join(os.homedir(), ".aive", "data");
}

function coreCliPath() {
  const pkgJson = require_.resolve("@aive/core/package.json");
  return path.join(path.dirname(pkgJson), "dist", "cli.js");
}

function readServerInfo(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  } catch {
    return null;
  }
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Spawn a fresh core. `execPath` is the binary to run the CLI with — under
 * Electron that's the Electron binary (with ELECTRON_RUN_AS_NODE), under tests
 * it's plain node. Resolves with { child, port } once the core reports ready.
 */
function startCore(dir, execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath || process.execPath, [coreCliPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AIVE_DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out waiting for editor core to start"));
      }
    }, 20000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === "ready" && msg.port && !settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ child, port: msg.port });
          }
        } catch {
          /* non-JSON log line; ignore */
        }
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[core] ${d}`));
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Core exited before ready (code ${code})`));
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Ensure a core is available. Returns { port, owned, child }.
 *   owned=false → attached to a core someone else started (do NOT kill it).
 *   owned=true  → we spawned it (kill it on quit).
 */
async function ensureCore(execPath) {
  const dir = getDataDir();
  const info = readServerInfo(dir);
  if (info && info.port && (await healthCheck(info.port))) {
    return { port: info.port, owned: false, child: null };
  }
  const { child, port } = await startCore(dir, execPath);
  return { port, owned: true, child };
}

module.exports = { ensureCore, startCore, getDataDir, coreCliPath, readServerInfo, healthCheck };
