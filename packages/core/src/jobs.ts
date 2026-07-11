import { EventEmitter } from "node:events";
import { newId } from "./ids.js";

/**
 * Long-running work tracking for the engine. Every slow operation (export,
 * preview, transcription, reframe, stabilize, proxy, visual indexing, motion
 * graphics) runs as a Job: observable (`list`), cancelable (`cancel` → the
 * job's AbortSignal fires), and progress-reporting. This is what lets the AI
 * behave like a real operator — start work, watch it, and abort it — and it
 * feeds live progress to the desktop UI over the WebSocket for free.
 */

export type JobType =
  | "export"
  | "preview"
  | "transcribe"
  | "reframe"
  | "stabilize"
  | "proxy"
  | "index_visual"
  | "graphic";

export type JobStatus = "running" | "done" | "error" | "canceled";

export interface Job {
  id: string;
  type: JobType;
  /** Human/AI-readable one-liner, e.g. `Export → final.mp4`. */
  label: string;
  status: JobStatus;
  /** Progress 0..1 (0 when the operation can't report progress). */
  fraction: number;
  startedAt: number;
  endedAt?: number;
  /** Present when status === "done" and the job produced a summarizable result. */
  result?: unknown;
  /** Present when status === "error" (the thrown message). */
  error?: string;
}

/** How many finished job records to keep for `list` (running jobs never drop). */
const KEEP_FINISHED = 50;

interface TrackedJob {
  job: Job;
  abort: AbortController;
  promise: Promise<unknown>;
}

export class JobManager extends EventEmitter {
  private tracked = new Map<string, TrackedJob>();

  override on(event: "job", listener: (job: Job) => void): this {
    return super.on(event, listener);
  }

  /**
   * Start a job. `run` receives the job's AbortSignal (wire it into every
   * ffmpeg/subprocess step so cancel actually stops the work) and an
   * `onProgress(fraction)` callback. Returns the Job record and the settled
   * promise — blocking callers await `promise`; background callers keep only
   * `job.id` and poll. Rejections are captured on the job, so an unawaited
   * background job never crashes the process.
   */
  start<T>(
    type: JobType,
    label: string,
    run: (signal: AbortSignal, onProgress: (fraction: number) => void) => Promise<T>,
  ): { job: Job; promise: Promise<T> } {
    const abort = new AbortController();
    const job: Job = {
      id: newId("job"),
      type,
      label,
      status: "running",
      fraction: 0,
      startedAt: Date.now(),
    };

    const onProgress = (fraction: number) => {
      if (job.status !== "running") return;
      job.fraction = Math.max(0, Math.min(1, fraction));
      this.emit("job", { ...job });
    };

    const promise = (async () => run(abort.signal, onProgress))().then(
      (result) => {
        if (job.status === "running") {
          job.status = "done";
          job.fraction = 1;
          job.result = summarizeResult(result);
        }
        job.endedAt = Date.now();
        this.emit("job", { ...job });
        return result;
      },
      (err: unknown) => {
        // An abort we initiated stays "canceled" even though the underlying
        // subprocess surfaces it as an error.
        if (job.status === "running") {
          job.status = abort.signal.aborted ? "canceled" : "error";
          if (job.status === "error") job.error = err instanceof Error ? err.message : String(err);
        }
        job.endedAt = Date.now();
        this.emit("job", { ...job });
        throw err;
      },
    );
    // Guard rejection for background (unawaited) callers.
    promise.catch(() => {});

    this.tracked.set(job.id, { job, abort, promise });
    this.prune();
    this.emit("job", { ...job });
    return { job, promise };
  }

  get(id: string): Job | undefined {
    const t = this.tracked.get(id);
    return t ? { ...t.job } : undefined;
  }

  /** Await a job's completion (rethrows its error). Undefined if unknown id. */
  wait(id: string): Promise<unknown> | undefined {
    return this.tracked.get(id)?.promise;
  }

  /** All jobs (newest first); activeOnly limits to status === "running". */
  list(activeOnly = false): Job[] {
    const all = [...this.tracked.values()].map((t) => ({ ...t.job }));
    all.sort((a, b) => b.startedAt - a.startedAt);
    return activeOnly ? all.filter((j) => j.status === "running") : all;
  }

  /**
   * Cancel a running job: fires its AbortSignal so in-flight ffmpeg/subprocess
   * work stops. Returns false if the job doesn't exist or already finished.
   */
  cancel(id: string): boolean {
    const t = this.tracked.get(id);
    if (!t || t.job.status !== "running") return false;
    t.job.status = "canceled";
    t.job.endedAt = Date.now();
    t.abort.abort();
    this.emit("job", { ...t.job });
    return true;
  }

  /** Drop the oldest finished records beyond the retention cap. */
  private prune(): void {
    const finished = [...this.tracked.values()]
      .filter((t) => t.job.status !== "running")
      .sort((a, b) => (b.job.endedAt ?? 0) - (a.job.endedAt ?? 0));
    for (const t of finished.slice(KEEP_FINISHED)) this.tracked.delete(t.job.id);
  }
}

/**
 * Keep only a compact, JSON-safe summary on the job record — job listings must
 * stay small (they're returned to the AI and broadcast to the UI), so big
 * results (full clips/assets) are reduced to their identifying fields.
 */
function summarizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return undefined;
  if (typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["path", "duration", "clipId", "assetId", "segmentCount", "sampleCount", "graphicId"]) {
    if (r[key] !== undefined) summary[key] = r[key];
  }
  // Nested common shapes: {clip:{id}}, {asset:{id}}.
  const clip = r.clip as { id?: string } | undefined;
  if (clip?.id) summary.clipId = clip.id;
  const asset = r.asset as { id?: string } | undefined;
  if (asset?.id) summary.assetId = asset.id;
  return Object.keys(summary).length ? summary : undefined;
}
