/**
 * Stage the heavy local binaries/models the editor needs into
 * `apps/desktop/build/resources/aive/`, so electron-builder can ship them as
 * `extraResources` and the packaged app runs **fully offline on first launch**
 * for everything except motion graphics.
 *
 * Bundling strategy = HYBRID (see docs/PROJECT_STATUS.md §5 / the Phase-5 plan):
 *   bundled here  → FFmpeg + ffprobe, whisper-cli (+ DLLs) + base.en model,
 *                   YuNet ONNX, an OSS font (Noto Sans, OFL-1.1).
 *   NOT bundled   → Remotion's Chrome Headless Shell (downloaded on first
 *                   motion-graphics use; it is large and Remotion manages its
 *                   own robust cache). Larger whisper models also download on
 *                   demand.
 *
 * The packaged app points the engine's env overrides (AIVE_FFMPEG / AIVE_FFPROBE
 * / AIVE_WHISPER_BIN / AIVE_WHISPER_MODEL / AIVE_YUNET_MODEL / AIVE_FONT) at
 * these staged copies — see apps/desktop/electron/bundled-assets.cjs.
 *
 * Run from the repo root:  npx tsx apps/desktop/scripts/prepare-bundle.ts
 * Re-running is cheap: existing, correctly-sized files are left in place.
 *
 * We deliberately REUSE the engine's own download/setup code (ensureWhisper,
 * ensureYunetModel) so the bundled binaries are byte-identical to what the
 * editor would otherwise fetch at runtime — and so the slow downloads happen at
 * most once on this machine (they are cached under ~/.aive).
 */
import { mkdir, copyFile, readdir, stat, access, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";

// Import the engine's COMPILED setup code (run with `node`, which strips the TS
// types in this file natively). Using dist avoids tsx's ESM resolver, which
// trips over execa's deep deps on Node 24.
import { ensureWhisper, DEFAULT_MODEL } from "../../../packages/core/dist/whisper/setup.js";
import { ensureYunetModel } from "../../../packages/core/dist/reframe/detector.js";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/desktop/build/resources/aive */
const STAGE = join(here, "..", "build", "resources", "aive");

const isWin = process.platform === "win32";
const EXE = isWin ? ".exe" : "";

/** Noto Sans (SIL Open Font License 1.1) — redistributable, covers Latin/Greek/Cyrillic. */
const FONT_URL =
  "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf";
const FONT_LICENSE_URL = "https://raw.githubusercontent.com/googlefonts/noto-fonts/main/LICENSE";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable on PATH (or via an env override), returning its full path. */
async function findOnPath(name: string, envOverride?: string): Promise<string> {
  if (envOverride && process.env[envOverride]) {
    const v = process.env[envOverride]!;
    if (await exists(v)) return v;
  }
  const exe = name + EXE;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, exe);
    if (await exists(cand)) return cand;
  }
  throw new Error(
    `Could not find ${exe} on PATH. Install it (or set ${envOverride ?? "the path"}) before staging.`,
  );
}

/** Copy src → dest unless dest already exists with the same byte size. */
async function copyIfNeeded(src: string, dest: string): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const s = await stat(src);
  if (await exists(dest)) {
    const d = await stat(dest);
    if (d.size === s.size) return 0;
  }
  await copyFile(src, dest);
  return s.size;
}

async function download(url: string, dest: string, label: string): Promise<void> {
  if (await exists(dest)) {
    console.log(`  • ${label} already staged`);
    return;
  }
  console.log(`  • downloading ${label} …`);
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Failed to download ${label}: ${res.status} ${res.statusText}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}

async function main(): Promise<void> {
  console.log(`Staging bundled assets into ${STAGE}\n`);
  await mkdir(STAGE, { recursive: true });

  // 1. FFmpeg + ffprobe (subprocess; gyan.dev/BtbN static builds are self-contained).
  console.log("FFmpeg:");
  const ffmpeg = await findOnPath("ffmpeg", "AIVE_FFMPEG");
  const ffprobe = await findOnPath("ffprobe", "AIVE_FFPROBE");
  await copyIfNeeded(ffmpeg, join(STAGE, "ffmpeg", "ffmpeg" + EXE));
  await copyIfNeeded(ffprobe, join(STAGE, "ffmpeg", "ffprobe" + EXE));
  console.log(`  • staged ffmpeg + ffprobe from ${dirname(ffmpeg)}`);

  // 2. whisper-cli + sibling DLLs + base.en model (reuses ~/.aive cache).
  console.log("whisper.cpp:");
  const { bin, model } = await ensureWhisper(DEFAULT_MODEL);
  const binDir = dirname(bin);
  for (const e of await readdir(binDir, { withFileTypes: true })) {
    if (e.isFile()) await copyIfNeeded(join(binDir, e.name), join(STAGE, "whisper", "bin", e.name));
  }
  await copyIfNeeded(model, join(STAGE, "whisper", "models", basename(model)));
  console.log(`  • staged ${basename(bin)} (+ DLLs) and ${basename(model)}`);

  // 3. YuNet face-detection model (Apache-2.0).
  console.log("YuNet:");
  const yunet = await ensureYunetModel();
  await copyIfNeeded(yunet, join(STAGE, "models", basename(yunet)));
  console.log(`  • staged ${basename(yunet)}`);

  // 4. OSS font for drawtext/captions (Noto Sans, OFL-1.1).
  console.log("Font:");
  await download(FONT_URL, join(STAGE, "fonts", "NotoSans-Regular.ttf"), "Noto Sans Regular");
  await download(FONT_LICENSE_URL, join(STAGE, "fonts", "LICENSE-NotoSans.txt"), "Noto Sans license");
  console.log(`  • staged NotoSans-Regular.ttf`);

  // A marker so the resolver/docs can confirm what bundling profile shipped.
  await writeFile(
    join(STAGE, "bundle-manifest.json"),
    JSON.stringify(
      {
        profile: "hybrid",
        platform: `${process.platform}-${process.arch}`,
        stagedAt: new Date().toISOString(),
        bundled: ["ffmpeg", "ffprobe", "whisper-cli", DEFAULT_MODEL, "yunet", "noto-sans"],
        firstRunDownload: ["remotion-chrome-headless-shell"],
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\nDone. Bundle size: ${fmt(await dirSize(STAGE))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
