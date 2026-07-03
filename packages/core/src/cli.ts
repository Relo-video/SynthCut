#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { EditorEngine } from "./engine.js";
import { EditorServer } from "./server.js";
import { checkBinaries } from "./ffmpeg/executor.js";

/**
 * Entry point for the persistent editor backend. Started by the Electron app
 * (or run standalone for headless / AI-only use). Prints the chosen port so a
 * launcher can capture it; also writes it to <dataDir>/server.json.
 */
async function main(): Promise<void> {
  const dataDir = process.env.AIVE_DATA_DIR || join(homedir(), ".aive", "data");
  const port = process.env.AIVE_PORT ? Number(process.env.AIVE_PORT) : undefined;

  try {
    const bins = await checkBinaries();
    console.error(`[aive-core] ${bins.ffmpeg}`);
  } catch {
    console.error(
      "[aive-core] WARNING: ffmpeg/ffprobe not found on PATH. Install FFmpeg or set AIVE_FFMPEG / AIVE_FFPROBE.",
    );
  }

  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port, dataDir });
  const boundPort = await server.start();

  console.error(`[aive-core] listening on http://127.0.0.1:${boundPort}`);
  console.error(`[aive-core] data dir: ${dataDir}`);
  // Machine-readable line for launchers that parse stdout.
  console.log(JSON.stringify({ event: "ready", port: boundPort, dataDir }));

  const shutdown = async () => {
    console.error("[aive-core] shutting down...");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[aive-core] fatal:", err);
  process.exit(1);
});
