import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);

/** Resolve the data dir the core uses (must match @aive/core's default). */
export function getDataDir(): string {
  return process.env.AIVE_DATA_DIR || join(homedir(), ".aive", "data");
}

/** All diagnostic logging MUST go to stderr — stdout is the MCP stdio channel. */
function log(...args: unknown[]): void {
  console.error("[aive-mcp]", ...args);
}

interface ServerInfo {
  port: number;
  pid: number;
  startedAt: number;
}

async function readServerInfo(dataDir: string): Promise<ServerInfo | null> {
  try {
    const raw = await readFile(join(dataDir, "server.json"), "utf8");
    return JSON.parse(raw) as ServerInfo;
  } catch {
    return null;
  }
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function coreCliPath(): string {
  const pkgJson = require.resolve("@aive/core/package.json");
  return join(dirname(pkgJson), "dist", "cli.js");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects the MCP server to the editor core. Connection strategy, in order:
 *   1. AIVE_CORE_URL env var (explicit).
 *   2. A running instance discovered via <dataDir>/server.json.
 *   3. Spawn a fresh headless core (for AI-only use with no desktop app open).
 *
 * Reusing an already-running instance (step 2) is what keeps the AI and the
 * desktop UI pointed at the same single source of truth.
 */
export class CoreClient {
  private baseUrl = "";
  private child: ChildProcess | null = null;
  private readonly dataDir = getDataDir();

  get url(): string {
    return this.baseUrl;
  }

  async connect(): Promise<string> {
    // 1. Explicit URL.
    if (process.env.AIVE_CORE_URL) {
      const url = process.env.AIVE_CORE_URL.replace(/\/$/, "");
      if (await isHealthy(url)) {
        log(`connected to core at ${url} (from AIVE_CORE_URL)`);
        this.baseUrl = url;
        return url;
      }
      log(`AIVE_CORE_URL set to ${url} but it is not responding; falling back`);
    }

    // 2. Discover a running instance.
    const info = await readServerInfo(this.dataDir);
    if (info) {
      const url = `http://127.0.0.1:${info.port}`;
      if (await isHealthy(url)) {
        log(`connected to running core at ${url} (pid ${info.pid})`);
        this.baseUrl = url;
        return url;
      }
    }

    // 3. Spawn a headless core.
    return this.spawnCore();
  }

  private async spawnCore(): Promise<string> {
    const cliPath = coreCliPath();
    log(`no running core found; spawning headless core: ${cliPath}`);

    this.child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, AIVE_DATA_DIR: this.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[core] ${d}`));
    this.child.on("exit", (code) => log(`core process exited (code ${code})`));

    // Wait for it to publish server.json and pass a health check.
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(250);
      const info = await readServerInfo(this.dataDir);
      if (info) {
        const url = `http://127.0.0.1:${info.port}`;
        if (await isHealthy(url)) {
          log(`spawned core ready at ${url}`);
          this.baseUrl = url;
          return url;
        }
      }
    }
    throw new Error("Timed out waiting for the editor core to start.");
  }

  /** Call an RPC method on the core. Throws with the core's error message on failure. */
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.baseUrl) throw new Error("CoreClient is not connected");
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
    if (!json.ok) throw new Error(json.error || `RPC "${method}" failed`);
    return json.result as T;
  }

  /** Kill a core we spawned ourselves (no-op if we attached to an existing one). */
  dispose(): void {
    if (this.child && !this.child.killed) this.child.kill();
  }
}
