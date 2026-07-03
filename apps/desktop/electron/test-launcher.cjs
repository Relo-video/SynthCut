// Verifies the shared-session behavior of core-launcher.cjs:
//   - When a core is already running (e.g. spawned by the MCP server for the
//     AI), opening the app ATTACHES to it (owned=false) instead of spawning a
//     second one — so the user sees the AI's live timeline.
//   - When no core is running, the app spawns its own (owned=true).
const { startCore, ensureCore } = require("./core-launcher.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aive-launch-"));
  process.env.AIVE_DATA_DIR = dir;
  console.log("dataDir:", dir);

  // 1. Simulate an existing core (as if the MCP server started it for the AI).
  process.env.AIVE_PORT = "4931";
  const existing = await startCore(dir, process.execPath);
  console.log(`1. existing core running on port ${existing.port}`);

  // 2. App opens -> must ATTACH, not spawn.
  const attached = await ensureCore(process.execPath);
  console.log(`2. ensureCore -> ${attached.owned ? "SPAWNED (BAD)" : "attached (good)"} port ${attached.port}`);
  if (attached.owned) throw new Error("expected to ATTACH to the existing core, but spawned a new one");
  if (attached.port !== existing.port) throw new Error(`attached to wrong port ${attached.port}`);

  // 3. Existing core goes away; app opens again -> must spawn its own.
  existing.child.kill();
  delete process.env.AIVE_PORT; // let the new spawn use the default port
  await sleep(1500);
  const spawned = await ensureCore(process.execPath);
  console.log(`3. ensureCore -> ${spawned.owned ? "spawned (good)" : "attached (BAD)"} port ${spawned.port}`);
  if (!spawned.owned) throw new Error("expected to SPAWN a new core, but attached");
  spawned.child.kill();

  console.log("\nLAUNCHER SHARED-SESSION TEST PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("LAUNCHER TEST FAILED:", e);
  process.exit(1);
});
