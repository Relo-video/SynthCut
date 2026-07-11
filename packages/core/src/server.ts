import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import { EditorEngine } from "./engine.js";
import { dispatch, RpcError, methods } from "./rpc.js";
import { checkBinaries } from "./ffmpeg/executor.js";
import type { Project } from "./types.js";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/**
 * CORS headers are emitted ONLY for requests that presented the valid session
 * token (plus OPTIONS preflight). A hostile webpage cannot read the token (it
 * lives in server.json on disk), so it can never receive a CORS-readable
 * response — while the Electron renderer (file:// origin) and dev-vite pages,
 * which DO hold the token, keep working. This replaces the old blanket
 * `Access-Control-Allow-Origin: *`.
 */
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Aive-Token");
}

function sendJson(res: ServerResponse, status: number, body: unknown, withCors = true): void {
  if (withCors) cors(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The persistent local backend. Hosts the EditorEngine and exposes it over:
 *  - HTTP POST /rpc       — used by the MCP server (the AI).
 *  - WebSocket            — used by the desktop UI for live state + commands.
 *  - HTTP GET /file       — streams local media/preview files (Range-enabled)
 *                           so the UI can play previews.
 * One engine instance = one source of truth shared by AI and human.
 */
export class EditorServer {
  private readonly http = createServer((req, res) => this.handleHttp(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private clients = new Set<WebSocket>();
  private port = 0;
  /**
   * Per-run session token. Written to server.json (readable by local processes,
   * NOT by webpages) and required on every request: header `x-aive-token` for
   * HTTP, `?token=` for the WS upgrade and /file (media elements can't set
   * headers). Rotates on every core start.
   */
  private token = randomBytes(24).toString("base64url");

  constructor(
    readonly engine: EditorEngine,
    readonly options: { port?: number; dataDir: string } = { dataDir: process.cwd() },
  ) {
    this.http.on("upgrade", (req, socket, head) => {
      // WS upgrade auth: browsers can't set headers on WebSocket() so the token
      // rides the query string. Reject bad/missing tokens before the upgrade.
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      if (!this.isAuthorized(req, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    // Broadcast engine changes + render progress + job updates to all UI clients.
    this.engine.on("change", (project) =>
      this.broadcast({
        type: "state",
        project,
        filePath: this.engine.getCurrentPath() ?? null,
        recovery: this.engine.recoveryInfo(),
      }),
    );
    this.engine.on("progress", (info) => this.broadcast({ type: "progress", ...info }));
    this.engine.on("job", (job) => this.broadcast({ type: "job", job }));
  }

  async start(): Promise<number> {
    // `port: 0` means "pick an ephemeral port"; omit it to use AIVE_PORT or 4789.
    const desired = this.options.port ?? (process.env.AIVE_PORT ? Number(process.env.AIVE_PORT) : 4789);
    await new Promise<void>((resolve) => this.http.listen(desired, "127.0.0.1", resolve));
    const addr = this.http.address();
    this.port = typeof addr === "object" && addr ? addr.port : desired;

    // Publish discovery info so the MCP bridge / UI can find this instance.
    await mkdir(this.options.dataDir, { recursive: true });
    await writeFile(
      join(this.options.dataDir, "server.json"),
      JSON.stringify({ port: this.port, pid: process.pid, startedAt: Date.now(), token: this.token }, null, 2),
      "utf8",
    );
    return this.port;
  }

  getPort(): number {
    return this.port;
  }

  /** The session token local clients must present (also published in server.json). */
  getToken(): string {
    return this.token;
  }

  /** Constant-time-ish token check: header for HTTP, ?token= for WS//file. */
  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const presented = (req.headers["x-aive-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
    return presented.length > 0 && presented === this.token;
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ---- WebSocket -------------------------------------------------------------
  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "state",
        project: this.engine.getProject(),
        filePath: this.engine.getCurrentPath() ?? null,
        recovery: this.engine.recoveryInfo(),
      }),
    );

    ws.on("message", async (data) => {
      let msg: { type?: string; id?: string; method?: string; params?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }
      if (msg.type === "rpc" && msg.method) {
        try {
          const result = await dispatch(this.engine, msg.method, msg.params);
          ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "rpc_result",
              id: msg.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    });

    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private broadcast(message: { type: string } & Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // ---- HTTP ------------------------------------------------------------------
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const authed = this.isAuthorized(req, url);
    // CORS-readable responses only for token holders (see cors() above).
    const respond = (status: number, body: unknown) => sendJson(res, status, body, authed);

    if (req.method === "OPTIONS") {
      // Preflight carries no data; answer it so token-holding pages can follow
      // up with the real (authenticated) request.
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // Tokenless liveness ping for local discovery — but internals (ffmpeg
        // banner, project revision) only for authenticated callers.
        if (!authed) {
          sendJson(res, 200, { ok: true, port: this.port }, false);
          return;
        }
        const bins = await checkBinaries().catch((e) => ({ error: String(e) }));
        respond(200, { ok: true, port: this.port, ffmpeg: bins, revision: this.engine.getProject().revision });
        return;
      }

      if (!authed) {
        respond(401, {
          ok: false,
          error:
            "Unauthorized: missing or invalid session token. Read `token` from <dataDir>/server.json and send it as the `x-aive-token` header (HTTP) or `?token=` query param (WebSocket / /file).",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        respond(200, {
          ok: true,
          result: this.engine.getProject() satisfies Project,
          recovery: this.engine.recoveryInfo(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/methods") {
        const list = Object.entries(methods).map(([name, m]) => ({ name, description: m.description }));
        respond(200, { ok: true, methods: list });
        return;
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        const body = await readBody(req);
        let parsed: { method?: string; params?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          respond(400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        if (!parsed.method) {
          respond(400, { ok: false, error: "Missing 'method'" });
          return;
        }
        try {
          const result = await dispatch(this.engine, parsed.method, parsed.params);
          respond(200, { ok: true, result });
        } catch (err) {
          const status = err instanceof RpcError && err.code !== "handler_error" ? 400 : 500;
          respond(status, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/file") {
        await this.serveFile(url.searchParams.get("path"), req, res);
        return;
      }

      respond(404, { ok: false, error: "Not found" });
    } catch (err) {
      respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Stream a local file with HTTP Range support (needed for video seeking). */
  private async serveFile(path: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!path) {
      sendJson(res, 400, { ok: false, error: "Missing 'path'" });
      return;
    }
    if (!this.engine.isServablePath(path)) {
      sendJson(res, 403, {
        ok: false,
        error:
          "Forbidden: /file only serves files under the editor data dir or files belonging to imported assets. Import the media first (import_video), then stream the asset's own path.",
      });
      return;
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      sendJson(res, 404, { ok: false, error: "File not found" });
      return;
    }
    if (!info.isFile()) {
      sendJson(res, 400, { ok: false, error: "Not a file" });
      return;
    }

    cors(res);
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;
    const total = info.size;

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": type,
      });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": total, "Content-Type": type, "Accept-Ranges": "bytes" });
      createReadStream(path).pipe(res);
    }
  }
}
