import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Disk garbage collection for the engine's data dir. Render artifacts
 * (previews, frames, scopes, temp WAVs, cached segments) accumulate forever
 * otherwise — every preview is a new file. Policy, per subdirectory:
 *
 *   previews/       keep the newest 3
 *   frames/         keep the newest 20
 *   scopes/         keep the newest 10
 *   captions/*.wav + transcripts/*.wav
 *                   delete when older than 1 day (they're also deleted at the
 *                   source right after transcription; this catches strays)
 *   cache/segments/ LRU-pruned so the whole prunable set fits `maxBytes`
 *
 * proxies/ and baked/ are EXEMPT — projects reference those files.
 * Total budget: AIVE_CACHE_MAX_MB (default 2048).
 */

export interface GcOptions {
  /** Total byte budget across prunable dirs (default 2 GiB / AIVE_CACHE_MAX_MB). */
  maxBytes?: number;
}

export interface GcReport {
  deletedFiles: number;
  freedBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function cacheBudgetBytes(): number {
  const mb = Number(process.env.AIVE_CACHE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 1024 * 1024;
}

interface Entry {
  path: string;
  mtimeMs: number;
  size: number;
}

async function listFiles(dir: string): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // dir doesn't exist yet
  }
  const out: Entry[] = [];
  for (const name of names) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.isFile()) out.push({ path: p, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* raced deletion — skip */
    }
  }
  return out;
}

async function drop(entry: Entry, report: GcReport): Promise<void> {
  try {
    await rm(entry.path, { force: true });
    report.deletedFiles += 1;
    report.freedBytes += entry.size;
  } catch {
    /* file in use (e.g. preview still streaming) — try again next pass */
  }
}

/** Keep only the newest `keep` files in a dir; delete the rest. */
async function keepNewest(dir: string, keep: number, report: GcReport): Promise<Entry[]> {
  const files = (await listFiles(dir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(keep)) await drop(f, report);
  return files.slice(0, keep);
}

/** Prune the data dir per the policy above. Never throws — GC is best-effort. */
export async function pruneDataDir(dataDir: string, opts: GcOptions = {}): Promise<GcReport> {
  const report: GcReport = { deletedFiles: 0, freedBytes: 0 };
  const maxBytes = opts.maxBytes ?? cacheBudgetBytes();

  try {
    const kept: Entry[] = [];
    kept.push(...(await keepNewest(join(dataDir, "previews"), 3, report)));
    kept.push(...(await keepNewest(join(dataDir, "frames"), 20, report)));
    kept.push(...(await keepNewest(join(dataDir, "scopes"), 10, report)));

    // Stray transcription WAVs: normally deleted right after transcribe();
    // anything older than a day is an orphan from a crash.
    const cutoff = Date.now() - DAY_MS;
    for (const dir of ["captions", "transcripts"]) {
      for (const f of await listFiles(join(dataDir, dir))) {
        if (f.path.toLowerCase().endsWith(".wav") && f.mtimeMs < cutoff) await drop(f, report);
        else kept.push(f);
      }
    }

    // Segment render cache (Phase 4): LRU within the remaining byte budget.
    const segments = (await listFiles(join(dataDir, "cache", "segments"))).sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
    let used = kept.reduce((n, f) => n + f.size, 0);
    for (const f of segments) {
      if (used + f.size > maxBytes) await drop(f, report);
      else used += f.size;
    }
  } catch {
    /* never let GC break an edit session */
  }
  return report;
}
