// Electron main process. Responsibilities:
//   1. Ensure the @aive/core backend is running — REUSING one already started by
//      an AI client (MCP) if present, so the app and the AI share one session.
//   2. Open a window that loads the React renderer, passing it the core port.
//   3. Provide native file open/save dialogs to the renderer over IPC.
//   4. Tear down the core on quit ONLY if we were the ones who started it.
//
// Written in CommonJS so it runs directly under Electron with no build step.
const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { ensureCore } = require("./core-launcher.cjs");
const { applyBundledAssetEnv } = require("./bundled-assets.cjs");

// Branding: the display name (taskbar / jump-list / dialogs) and a stable Windows
// AppUserModelID so the taskbar shows OUR name + icon instead of "Electron" and
// groups our windows under one taskbar button. In a DEV run (not packaged) we use
// a distinct name + AppUserModelID so a source build is a SEPARATE taskbar entry
// and can't be confused with an installed copy. No effect on the shipped app.
const APP_NAME = app.isPackaged ? "SynthCut by Relo" : "SynthCut by Relo (DEV)";
const APP_ICON = path.join(__dirname, "..", "build", "icon.ico");
app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.relo.synthcut" : "com.relo.synthcut.dev");
}

let coreChild = null;
let coreOwned = false;
let corePort = null;
let coreToken = null;

// Project state mirrored from the renderer so the main process can guard quit.
let mainWin = null;
let projectUnsaved = false;
let projectHasPath = false;
let forceQuit = false;       // user chose to close anyway → allow the close
let pendingSaveQuit = false; // waiting for the renderer to finish saving, then quit

// No native OS menu bar — the app uses ONE custom title bar (Clipchamp-style).
// New/Open/Save live in the in-app Project menu; editing shortcuts (Ctrl+S/Z/Y)
// are handled in the renderer. Removing the menu also drops the Ctrl+/- page-zoom
// accelerators, which we don't want for a desktop app.
function buildMenu() {
  Menu.setApplicationMenu(null);
}

// Background auto-update (packaged builds only). On launch the app reads the
// GitHub Release feed (latest.yml), and if a newer version exists electron-updater
// downloads only the changed chunks (via the .blockmap) in the background, then
// installs on the next restart. Guarded by app.isPackaged so it NEVER runs during
// a `npm start` dev session. Update source is the `publish` block in package.json.
function setupAutoUpdate() {
  if (!app.isPackaged) return; // dev build — nothing to update against
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.error("[aive] electron-updater unavailable:", err && err.message ? err.message : err);
    return;
  }

  // Never crash the app over a failed/unreachable update check (offline, no
  // release yet, private repo, etc.) — just log and carry on.
  autoUpdater.on("error", (err) =>
    console.error("[aive] auto-update error:", err && err.message ? err.message : err));
  autoUpdater.on("update-available", (info) =>
    console.error(`[aive] update available: v${info.version} — downloading in background`));
  autoUpdater.on("update-not-available", () =>
    console.error("[aive] up to date"));

  // When the new version is fully downloaded, offer an immediate restart. Setting
  // forceQuit first bypasses the unsaved-changes quit guard in onWindowClose so
  // quitAndInstall() can relaunch cleanly.
  autoUpdater.on("update-downloaded", (info) => {
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "Update ready",
      message: `SynthCut ${info.version} has been downloaded.`,
      detail: "Restart to install it — the update installs on next launch if you choose Later.",
    });
    if (choice === 0) {
      forceQuit = true;
      autoUpdater.quitAndInstall();
    }
  });

  // Kick off the check. (checkForUpdates + autoDownload handles our own restart
  // UX; we don't use checkForUpdatesAndNotify since the dialog above replaces the
  // built-in OS notification.)
  autoUpdater.checkForUpdates().catch((err) =>
    console.error("[aive] update check failed:", err && err.message ? err.message : err));
}

/** Intercept window close to confirm unsaved changes (main-process dialog). */
function onWindowClose(e) {
  if (forceQuit || !projectUnsaved) return; // clean (or already confirmed) → allow
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(mainWin, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "Unsaved changes",
    message: "Save changes before closing?",
    detail: "Your project has unsaved edits.",
  });
  if (choice === 2) return; // Cancel — stay open
  if (choice === 1) { forceQuit = true; mainWin.close(); return; } // Don't Save
  // Save → ask the renderer to save; we quit once it reports the project clean.
  pendingSaveQuit = true;
  sendMenu(projectHasPath ? "save" : "save-as");
}

function createWindow(port, token) {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0e0f13",
    title: APP_NAME,
    icon: APP_ICON,
    // Single custom title bar (Clipchamp-style): hide the OS title bar but keep
    // the native min/max/close buttons overlaid in the top-right of OUR top bar.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#131419", symbolColor: "#c4c9d6", height: 52 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWin = win;
  win.on("close", onWindowClose);
  win.on("closed", () => { if (mainWin === win) mainWin = null; });

  // Lock the page zoom: a desktop app must never pinch/Ctrl-zoom the whole UI.
  // Renderer-side preventDefault isn't enough on its own — Chromium can still
  // apply Ctrl+wheel / Ctrl+±/pinch zoom — so we hard-lock it in the main process:
  // clamp the zoom range to 1×, and snap any zoom change straight back to 1×.
  const lockZoom = () => {
    win.webContents.setVisualZoomLevelLimits(1, 1); // disable trackpad pinch-zoom
    win.webContents.setZoomLevel(0);
    win.webContents.setZoomFactor(1);
  };
  win.webContents.on("did-finish-load", lockZoom);
  win.webContents.on("zoom-changed", () => lockZoom());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(`${devUrl}?port=${port}&token=${encodeURIComponent(token || "")}`);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"), {
      query: { port: String(port), token: String(token || "") },
    });
  }
}

// The renderer reports its dirty/has-file state so quit-guard logic can use it.
ipcMain.on("project:state", (_e, state) => {
  projectUnsaved = !!(state && state.dirty);
  projectHasPath = !!(state && state.hasPath);
  // A save we requested before quitting just completed → proceed to close.
  if (pendingSaveQuit && !projectUnsaved) {
    pendingSaveQuit = false;
    forceQuit = true;
    if (mainWin) mainWin.close();
  }
});

ipcMain.handle("dialog:openFiles", async () => {
  const result = await dialog.showOpenDialog({
    title: "Import media",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wav", "mp3", "aac", "png", "jpg", "jpeg", "webp", "gif", "bmp"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:saveFile", async () => {
  const result = await dialog.showSaveDialog({
    title: "Export video",
    defaultPath: "export.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle("dialog:openProject", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open project",
    properties: ["openFile"],
    filters: [
      { name: "AI-Native Project", extensions: ["aive"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle("dialog:saveProject", async (_e, defaultName) => {
  const base = (defaultName && String(defaultName)) || "Untitled";
  const result = await dialog.showSaveDialog({
    title: "Save project as",
    defaultPath: `${base.replace(/\.aive$/i, "")}.aive`,
    filters: [{ name: "AI-Native Project", extensions: ["aive"] }],
  });
  return result.canceled ? null : result.filePath;
});

// Build a ready-to-paste MCP client config for THIS install, so the user never
// has to guess a "<REPO_PATH>". In a packaged app there is no Node on the user's
// machine, so we launch the bundled MCP server with the app's own Electron binary
// running in Node mode (ELECTRON_RUN_AS_NODE) — the same trick used for the core.
// From a source checkout, plain `node` is available and clearer.
ipcMain.handle("mcp:config", () => {
  let mcpEntry = null;
  try {
    mcpEntry = path.join(path.dirname(require.resolve("@aive/mcp/package.json")), "dist", "index.js");
  } catch {
    mcpEntry = null;
  }
  const packaged = app.isPackaged;
  const server = packaged
    ? { command: process.execPath, args: [mcpEntry], env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { command: "node", args: [mcpEntry] };
  const config = { mcpServers: { "ai-video-editor": server } };
  return {
    available: !!mcpEntry,
    packaged,
    mcpEntry,
    json: JSON.stringify(config, null, 2),
  };
});

app.whenReady().then(async () => {
  try {
    // In a packaged build, point the core at the bundled ffmpeg/whisper/YuNet/font
    // so the first run is offline. No-op in dev. Must run BEFORE ensureCore, which
    // spawns the core inheriting process.env.
    const bundle = applyBundledAssetEnv(app);
    if (bundle.applied) console.error(`[aive] using bundled assets (${bundle.vars.join(", ")})`);

    const result = await ensureCore(process.execPath);
    corePort = result.port;
    coreToken = result.token;
    coreOwned = result.owned;
    coreChild = result.child;
    console.error(`[aive] ${coreOwned ? "started" : "attached to existing"} core on port ${corePort}`);
    buildMenu();
    createWindow(corePort, coreToken);
    setupAutoUpdate();
  } catch (err) {
    dialog.showErrorBox(
      "Could not start the editor core",
      `${err && err.message ? err.message : err}\n\n` +
        'Make sure the project is built (run "npm run build" at the repo root) and that FFmpeg is installed.',
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && corePort) createWindow(corePort, coreToken);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  // Only kill the core if WE started it. If we attached to an AI-started core,
  // leave it running so the AI's session survives the window closing.
  if (coreOwned && coreChild && !coreChild.killed) coreChild.kill();
});
