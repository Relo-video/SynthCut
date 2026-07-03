// Points the editor core at the binaries/models bundled into a PACKAGED build.
//
// electron-builder copies apps/desktop/build/resources/aive → <app>/resources/aive
// (process.resourcesPath/aive). At startup the main process calls
// applyBundledAssetEnv() BEFORE spawning the core, setting the same env overrides
// the engine already understands (see executor.ts / whisper/setup.ts /
// reframe/detector.ts / engine.stageFont). The spawned core inherits them, so
// import/edit/export, captions and auto-reframe run **fully offline on first
// launch** — no PATH ffmpeg, no first-run downloads.
//
// In DEV (not packaged) this is a no-op: we keep relying on a PATH ffmpeg and the
// engine's own ~/.aive download-on-first-use path.
//
// Hybrid bundling: Remotion's Chrome Headless Shell is intentionally NOT bundled
// (it is large and Remotion manages its own cache); it downloads on first
// motion-graphics use. Everything else is local from the first run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withExe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

// Only set an override if the caller hasn't already (explicit env wins) and the
// bundled file actually exists — so a partial/!staged bundle degrades to the
// normal download path instead of pointing at a missing file.
function setIfPresent(key, file) {
  if (process.env[key]) return false;
  if (!fs.existsSync(file)) return false;
  process.env[key] = file;
  return true;
}

/**
 * Seed the bundled base.en whisper model into the user's writable cache
 * (~/.aive/whisper/models) if it isn't there yet. We do this rather than pinning
 * AIVE_WHISPER_MODEL so that captions work offline with base.en out of the box
 * AND the user can still request other models (which download on demand into the
 * same writable cache). resourcesPath is read-only, so we can't download there.
 */
function seedWhisperModel(root) {
  try {
    const src = path.join(root, "whisper", "models", "ggml-base.en.bin");
    if (!fs.existsSync(src)) return;
    const cacheDir = process.env.AIVE_WHISPER_DIR || path.join(os.homedir(), ".aive", "whisper");
    const dest = path.join(cacheDir, "models", "ggml-base.en.bin");
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch {
    // Non-fatal: if seeding fails, the engine just downloads the model on first use.
  }
}

/**
 * Apply bundled-asset env overrides for a packaged build. Returns a small report
 * for logging. Safe to call unconditionally.
 */
function applyBundledAssetEnv(app) {
  if (!app || !app.isPackaged) return { applied: false, reason: "dev (not packaged)" };

  const root = path.join(process.resourcesPath, "aive");
  if (!fs.existsSync(root)) return { applied: false, reason: `no bundle at ${root}` };

  const applied = [];
  const map = {
    AIVE_FFMPEG: path.join(root, "ffmpeg", withExe("ffmpeg")),
    AIVE_FFPROBE: path.join(root, "ffmpeg", withExe("ffprobe")),
    // whisper-cli loads its sibling DLLs from its own directory automatically.
    AIVE_WHISPER_BIN: path.join(root, "whisper", "bin", withExe("whisper-cli")),
    AIVE_YUNET_MODEL: path.join(root, "models", "face_detection_yunet_2023mar.onnx"),
    AIVE_FONT: path.join(root, "fonts", "NotoSans-Regular.ttf"),
  };
  for (const [key, file] of Object.entries(map)) {
    if (setIfPresent(key, file)) applied.push(key);
  }

  seedWhisperModel(root);

  return { applied: true, root, vars: applied };
}

module.exports = { applyBundledAssetEnv };
