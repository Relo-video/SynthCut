/**
 * SOTA Phase 2 deliverable: long-running work is observable and cancelable.
 *  - export_video with background:true returns a jobId immediately.
 *  - list_jobs shows the job running with a rising fraction.
 *  - cancel_job aborts it: status "canceled", partial output file deleted.
 *  - A short blocking export still completes and lands in list_jobs as "done".
 *  - Crash-recovery autosave surfaces via get_state.recovery (schedule check).
 *
 * Run: npx tsx packages/core/scripts/smoke-jobs.ts
 * (No media arguments needed — synthesizes a long color-source clip with ffmpeg.)
 */
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import type { Job } from "../src/jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-jobs-"));
  const engine = new EditorEngine(dataDir);

  // Dispatch exactly like the server: schema-validate, then run the handler.
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. synthesize a long color-source clip (3 min @ 30fps, 1080p)...");
  const srcPath = join(dataDir, "long-color.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=180",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=180",
    "-shortest", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-y", srcPath,
  ]);
  const imported = await call<{ asset: { id: string } }>("import_video", { path: srcPath });
  await call("append_clip", { assetId: imported.asset.id });

  console.log("2. background export returns a jobId immediately...");
  const outPath = join(dataDir, "background-export.mp4");
  const t0 = Date.now();
  const started = await call<{ jobId: string; status: string }>("export_video", {
    outputPath: outPath,
    background: true,
    quality: 10, // near-lossless + x264's slowest preset: slow enough to observe + cancel
    encoderPreset: "placebo",
  });
  check(typeof started.jobId === "string" && started.jobId.length > 0, "background export_video returned a jobId");
  check(Date.now() - t0 < 5000, "background call returned without blocking on the render");

  console.log("3. observe progress via list_jobs...");
  let sawRunning = false;
  let lastFraction = 0;
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    const { jobs } = await call<{ jobs: Job[] }>("list_jobs", {});
    const job = jobs.find((j) => j.id === started.jobId);
    if (!job) break;
    if (job.status === "running") sawRunning = true;
    if (job.fraction > lastFraction) lastFraction = job.fraction;
    // Cancel once we've seen real progress (fraction moved off zero).
    if (job.status === "running" && job.fraction > 0.005) break;
    if (job.status !== "running") break; // finished too fast — still fine, we assert below
  }
  check(sawRunning, "job was observable in list_jobs while running");
  check(lastFraction > 0, `fraction rose above 0 (got ${lastFraction.toFixed(3)})`);

  console.log("4. cancel the running export...");
  const cancelResult = await call<{ canceled: boolean; job?: Job }>("cancel_job", { jobId: started.jobId });
  check(cancelResult.canceled, "cancel_job canceled the running job");
  // Give the ffmpeg process a moment to die and cleanup to run.
  let final: Job | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    final = (await call<{ jobs: Job[] }>("list_jobs", {})).jobs.find((j) => j.id === started.jobId);
    if (final && final.status !== "running" && !existsSync(outPath)) break;
  }
  check(final?.status === "canceled", `job status is canceled (got ${final?.status})`);
  check(!existsSync(outPath), "no partial output file left behind");

  console.log("5. cancel_job on an unknown id teaches...");
  let taught = false;
  try {
    await call("cancel_job", { jobId: "job_does_not_exist" });
  } catch (err) {
    taught = /list_jobs/.test(err instanceof Error ? err.message : "");
  }
  check(taught, "unknown jobId error mentions list_jobs");

  console.log("6. short blocking export still completes and is recorded...");
  await call("trim_clip", {
    clipId: (await call<{ tracks: { clips: { clipId: string }[] }[] }>("timeline_summary", {})).tracks[0].clips[0].clipId,
    sourceOutFrame: 60, // 2 seconds
  });
  const shortOut = join(dataDir, "short-export.mp4");
  const done = await call<{ path: string }>("export_video", { outputPath: shortOut });
  check(existsSync(done.path), "blocking export produced the file");
  const record = (await call<{ jobs: Job[] }>("list_jobs", {})).jobs.find(
    (j) => j.type === "export" && j.status === "done",
  );
  check(!!record && record.fraction === 1, "completed export recorded as done with fraction 1");

  console.log("7. crash-recovery snapshot is surfaced on startup...");
  // Simulate a crashed session: drop a recovery file where a fresh engine will look.
  const recoveredDir = mkdtempSync(join(tmpdir(), "aive-recovery-"));
  const autosaveDir = join(recoveredDir, "autosave");
  mkdirSync(autosaveDir, { recursive: true });
  const recoveryFile = join(autosaveDir, "current.aive.recovery");
  writeFileSync(recoveryFile, JSON.stringify(engine.getProject(), null, 2), "utf8");
  const engine2 = new EditorEngine(recoveredDir);
  const info = engine2.recoveryInfo();
  check(info.available && info.path === recoveryFile, "fresh engine reports recovery.available with the path");
  // And the recovery file is a loadable project.
  await engine2.load(recoveryFile);
  check(engine2.getProject().assets.length === 1, "recovery file loads as a project via load_project path");

  console.log(failures === 0 ? "\nJOBS SMOKE TEST PASSED" : `\nJOBS SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("JOBS SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
