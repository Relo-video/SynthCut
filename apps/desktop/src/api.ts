import type { Project, ProgressInfo } from "./types";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Client for the editor core. Holds a live WebSocket for state + progress
 * broadcasts and issues RPC commands over the same socket. Auto-reconnects so
 * the UI survives a core restart. The same RPC methods the AI uses are
 * available here, so manual UI edits and AI edits share one engine.
 */
export class CoreApi {
  private ws: WebSocket | null = null;
  private readonly base: string;
  private readonly wsUrl: string;
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  private stateCb?: (p: Project, filePath: string | null) => void;
  private progressCb?: (i: ProgressInfo) => void;
  private statusCb?: (connected: boolean) => void;
  private closed = false;
  /** Absolute .aive path of the open project, or null if never saved. */
  filePath: string | null = null;

  constructor(readonly port: number) {
    this.base = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}`;
  }

  onState(cb: (p: Project, filePath: string | null) => void): void {
    this.stateCb = cb;
  }
  onProgress(cb: (i: ProgressInfo) => void): void {
    this.progressCb = cb;
  }
  onStatus(cb: (connected: boolean) => void): void {
    this.statusCb = cb;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => this.statusCb?.(true);

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "state":
          this.filePath = (msg.filePath as string | null) ?? null;
          this.stateCb?.(msg.project as Project, this.filePath);
          break;
        case "progress":
          this.progressCb?.({ job: msg.job as ProgressInfo["job"], fraction: msg.fraction as number });
          break;
        case "rpc_result": {
          const p = this.pending.get(msg.id as number);
          if (!p) break;
          this.pending.delete(msg.id as number);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error((msg.error as string) || "RPC failed"));
          break;
        }
      }
    };

    ws.onclose = () => {
      this.statusCb?.(false);
      if (!this.closed) setTimeout(() => this.open(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  /** Send an RPC command to the engine and await its result. */
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the editor core"));
        return;
      }
      const id = ++this.reqId;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }

  /** Build a URL the <video>/<img> tags can use to stream a local file. */
  fileUrl(path: string): string {
    return `${this.base}/file?path=${encodeURIComponent(path)}`;
  }

  get httpBase(): string {
    return this.base;
  }
}
