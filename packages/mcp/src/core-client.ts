import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import WebSocket from "ws";

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
  /** Session token required on every request (header `x-aive-token`). */
  token?: string;
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
/** A progress/job broadcast from the core (relayed to MCP progress notifications). */
export interface CoreEvent {
  type: "progress" | "job";
  /** progress events: 0..1. */
  fraction?: number;
  job?: { id: string; type: string; label: string; status: string; fraction: number };
}

export class CoreClient {
  private baseUrl = "";
  private token = "";
  private child: ChildProcess | null = null;
  private readonly dataDir = getDataDir();
  private ws: WebSocket | null = null;
  private wsClosed = false;
  private readonly eventCbs = new Set<(ev: CoreEvent) => void>();

  get url(): string {
    return this.baseUrl;
  }

  /**
   * Subscribe to the core's progress/job broadcasts (delivered over its
   * WebSocket). Returns an unsubscribe function. Used to forward render
   * progress as MCP `notifications/progress` so the AI stops flying blind
   * during long exports/transcriptions.
   */
  onEvent(cb: (ev: CoreEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /** Open (and keep re-opening) the WS event channel to the core. */
  private openEvents(): void {
    if (this.wsClosed || !this.baseUrl) return;
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as CoreEvent & { type?: string };
        if (msg.type === "progress" || msg.type === "job") {
          for (const cb of this.eventCbs) cb(msg);
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    });
    ws.on("close", () => {
      if (!this.wsClosed && this.ws === ws) {
        const t = setTimeout(() => this.openEvents(), 2000);
        t.unref?.();
      }
    });
    ws.on("error", () => ws.close());
  }

  /** The core's session token (from AIVE_CORE_TOKEN or server.json). */
  getToken(): string {
    return this.token;
  }

  async connect(): Promise<string> {
    // 1. Explicit URL. The token comes from AIVE_CORE_TOKEN, or (same-machine
    //    case) from the discovery file the core writes next to its data.
    if (process.env.AIVE_CORE_URL) {
      const url = process.env.AIVE_CORE_URL.replace(/\/$/, "");
      if (await isHealthy(url)) {
        log(`connected to core at ${url} (from AIVE_CORE_URL)`);
        this.baseUrl = url;
        this.token = process.env.AIVE_CORE_TOKEN || (await readServerInfo(this.dataDir))?.token || "";
        this.openEvents();
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
        this.token = info.token ?? "";
        this.openEvents();
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
          this.token = info.token ?? "";
          this.openEvents();
          return url;
        }
      }
    }
    throw new Error("Timed out waiting for the editor core to start.");
  }

  /**
   * Call an RPC method on the core. Throws with the core's error message on
   * failure. The core's port/token rotate every run, so if the call fails in a
   * way that smells like a restarted core (auth rejection or connection error),
   * re-discover it via connect() and retry once instead of staying stranded on
   * stale credentials.
   */
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.baseUrl) throw new Error("CoreClient is not connected");
    try {
      return await this.rpcOnce<T>(method, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const coreRestarted =
        msg.includes("invalid session token") ||
        msg.includes("fetch failed") ||
        err instanceof TypeError;
      if (coreRestarted && (await this.rediscover())) {
        return this.rpcOnce<T>(method, params);
      }
      throw err;
    }
  }

  private async rpcOnce<T = unknown>(method: string, params: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aive-token": this.token },
      body: JSON.stringify({ method, params }),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
    if (!json.ok) throw new Error(json.error || `RPC "${method}" failed`);
    return json.result as T;
  }

  /** Re-run discovery after an apparent core restart. Replaces the event WS. */
  private async rediscover(): Promise<boolean> {
    try {
      const old = this.ws;
      this.ws = null;
      old?.close();
      await this.connect();
      log("re-discovered core after restart (token/port refreshed)");
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a core we spawned ourselves (no-op if we attached to an existing one). */
  dispose(): void {
    this.wsClosed = true;
    this.ws?.close();
    if (this.child && !this.child.killed) this.child.kill();
  }
}
