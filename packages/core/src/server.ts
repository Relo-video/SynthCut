import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
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

  constructor(
    readonly engine: EditorEngine,
    readonly options: { port?: number; dataDir: string } = { dataDir: process.cwd() },
  ) {
    this.http.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    // Broadcast engine changes + render progress to all UI clients.
    this.engine.on("change", (project) => this.broadcast({ type: "state", project, filePath: this.engine.getCurrentPath() ?? null }));
    this.engine.on("progress", (info) => this.broadcast({ type: "progress", ...info }));
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
      JSON.stringify({ port: this.port, pid: process.pid, startedAt: Date.now() }, null, 2),
      "utf8",
    );
    return this.port;
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ---- WebSocket -------------------------------------------------------------
  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: "state", project: this.engine.getProject(), filePath: this.engine.getCurrentPath() ?? null }));

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

    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const bins = await checkBinaries().catch((e) => ({ error: String(e) }));
        sendJson(res, 200, { ok: true, port: this.port, ffmpeg: bins, revision: this.engine.getProject().revision });
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        sendJson(res, 200, { ok: true, result: this.engine.getProject() satisfies Project });
        return;
      }

      if (req.method === "GET" && url.pathname === "/methods") {
        const list = Object.entries(methods).map(([name, m]) => ({ name, description: m.description }));
        sendJson(res, 200, { ok: true, methods: list });
        return;
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        const body = await readBody(req);
        let parsed: { method?: string; params?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        if (!parsed.method) {
          sendJson(res, 400, { ok: false, error: "Missing 'method'" });
          return;
        }
        try {
          const result = await dispatch(this.engine, parsed.method, parsed.params);
          sendJson(res, 200, { ok: true, result });
        } catch (err) {
          const status = err instanceof RpcError && err.code !== "handler_error" ? 400 : 500;
          sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/file") {
        await this.serveFile(url.searchParams.get("path"), req, res);
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Stream a local file with HTTP Range support (needed for video seeking). */
  private async serveFile(path: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!path) {
      sendJson(res, 400, { ok: false, error: "Missing 'path'" });
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
