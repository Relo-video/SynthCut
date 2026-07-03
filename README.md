# AI-Native Video Editor

An open-source video editor built to be operated by **AI, not humans**.

Every video editor today — Premiere, DaVinci Resolve, CapCut — is designed for a person to click and drag. AI models can understand a user's creative intent perfectly, but they can't *operate* those tools. This project flips that: the AI is the primary operator. You describe the edit in plain language, the AI does it, you review and course-correct.

The editor exposes itself as an **MCP (Model Context Protocol) server**, so any MCP-compatible client — Claude Desktop or others — connects and drives it directly. All processing is **local and offline** via FFmpeg. Your footage never leaves your machine.

> **Status:** Stable. A full multi-track, frame-based editor with **85 MCP tools** — from import/cut/trim to per-clip transforms + keyframe animation, color grading, an effects stack, Whisper captions, subject-aware auto-reframe, motion graphics, media intelligence (transcript + semantic visual search), and platform export presets. Built in phases, each fully working before the next. See [Roadmap](#roadmap).

## Download & install (Windows)

For people who just want to **use** the app — no build tools or coding needed.

1. Open the [**Releases**](../../releases) page and grab the latest build.
2. Download **one** of:
   - **`SynthCut by Relo <version>.exe`** — installer (adds a Desktop + Start‑menu shortcut), or
   - **`SynthCut by Relo <version>.zip`** — portable: unzip anywhere and run `SynthCut by Relo.exe` (no install).
3. **Windows SmartScreen** may show *"Windows protected your PC."* This app is open‑source and **not code‑signed** (trusted certificates cost money). It is safe — click **More info → Run anyway**.

Everything (FFmpeg, Whisper, etc.) is bundled, so it runs fully offline. To drive it with AI, connect an MCP client (e.g. Claude Desktop) — see the **Connect AI** button in the app.

### Verify your download (optional but recommended)

Each release includes `SHA256SUMS.txt`. Confirm your file is intact — in PowerShell:

```powershell
Get-FileHash ".\SynthCut by Relo <version>.exe" -Algorithm SHA256
```

Compare the hash to the matching line in `SHA256SUMS.txt`. (This is the no‑cost stand‑in for a code signature.)

> Maintainers: to cut a new version and ship it to installed users via auto-update, see [`docs/RELEASING.md`](docs/RELEASING.md). For free OSS code signing via SignPath Foundation see [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md); the CI is in [`.github/workflows/release.yml`](.github/workflows/release.yml).

## How it works

```
                 ┌────────────────────────────────────────┐
                 │            @aive/core  (Node/TS)         │
                 │  • Non-destructive timeline (EDL)        │
                 │  • FFmpeg / ffprobe executor             │
                 │  • Preview + export render pipeline      │
                 │  • Persistence · undo/redo · event bus   │
                 └───────▲───────────────────────▲──────────┘
                  MCP (tools)                WebSocket (live state)
            ┌────────────┴───────────┐   ┌────────┴────────────────┐
            │  Claude Desktop / any  │   │   Electron + React UI    │
            │   MCP client (the AI)  │   │  timeline · preview ·    │
            │                        │   │  clips · prompt panel    │
            └────────────────────────┘   └──────────────────────────┘
```

A single persistent **core** owns all editing state. The AI mutates a non-destructive timeline through MCP tools (`import_video`, `cut_clip`, `concat`, `export_video`, …); the UI reflects every change live over WebSocket. Both act on one source of truth, so the AI and the human never fall out of sync.

## Tech

- **FFmpeg** — all video processing, fully local. Invoked as an external process (not linked). It ships as a GPL build, which is compatible with this project's GPL-3.0 license.
- **Whisper (whisper.cpp)** — local speech-to-text for captions. *(Phase 3)*
- **Remotion** — AI-authored React components for motion graphics. *(Phase 4)*
- **MCP server** — clean tool definitions any MCP client can call.
- **Electron + React** — desktop UI: timeline, clip library, preview.

## Repository layout

```
packages/core    @aive/core  — headless editing engine + WebSocket server
packages/mcp     @aive/mcp   — MCP server exposing editor tools to AI clients
apps/desktop                 — Electron + React desktop UI  (Phase 1)
```

## Roadmap

- **Phase 0** — Monorepo scaffold ✅
- **Phase 1** — Core engine + MCP tools + Electron UI: import, cut/trim/split/concat/reorder, preview, export, undo/redo ✅
- **Phase 2** — Reframe (9:16/1:1/16:9) + crop, color grade + LUTs, speed ramps, fades, crossfade transitions, stabilization, background music + ducking, and burned-in text overlays ✅
- **Phase 3** — Whisper captions + subject-tracking auto-reframe + J/L audio cuts ✅
- **Phase 4** — Remotion motion graphics (AI-authored React components → alpha overlays) ✅
- **Phase 5** — Packaged Windows installer (offline-first, bundled FFmpeg + Whisper + YuNet + font), `THIRD_PARTY_LICENSES`, docs, contributor guide ✅ *(macOS/Linux installers configured but not yet built)*

Beyond the initial roadmap, the editor grew into a full multi-track workstation: a real-time Canvas2D compositor, per-clip transforms with keyframe animation, color grading (wheels/curves/white-balance) and a stackable effects chain, media intelligence (folders, transcript indexing + search, perceptual and CLIP semantic visual search, audio sync), a vision-based `inspect_timeline` loop for the AI, native keyframe-animated text, platform export presets, and proxy media for fast preview.

**85 MCP tools** in total — each is simultaneously an AI tool and a UI action, defined exactly once in the core's RPC registry.

## Install (packaged app)

The Windows installer is **offline-first**: it bundles FFmpeg + ffprobe, whisper.cpp with the `base.en` model, the YuNet face-detection model, and an open-source font, so import/edit/export, captions, and auto-reframe all work on first launch with **no downloads**. Motion graphics (Remotion) downloads its headless Chrome the first time you use it.

1. Run **`AI-Native Video Editor <version> Setup.exe`** and follow the installer.
2. Because the build is **unsigned**, Windows SmartScreen may warn ("Windows protected your PC"). Click **More info → Run anyway**. (We can drop in an Authenticode certificate later — the config has a hook for it.)
3. To drive it with AI, point Claude Desktop at the MCP server — see [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) and [`claude_desktop_config.example.json`](claude_desktop_config.example.json).

## Build from source

```bash
npm install
npm run build      # builds core + mcp + the renderer
npm start          # launches the desktop app (auto-starts/attaches the core)
```

To verify everything end-to-end (automated smoke tests, manual UI, the AI path, and the offline installer), follow **[`docs/TESTING.md`](docs/TESTING.md)**.

### Run on macOS & Linux (from source)

There is **no packaged installer for macOS or Linux yet** — the current release build (and its auto-update) is Windows-only. On those platforms you run the app **from source**, which is fully supported: Electron, Node, and FFmpeg are all cross-platform.

```bash
# 1. Prerequisites
#    • Node.js >= 20        (https://nodejs.org  — or `brew install node`)
#    • Git
#    • FFmpeg + ffprobe on your PATH:
#         macOS:  brew install ffmpeg
#         Linux:  sudo apt install ffmpeg          # Debian / Ubuntu

# 2. Clone, build, run
git clone <your-repo-url>
cd AI_native_editor
npm install
npm run build      # builds core + mcp + renderer
npm start          # launches the Electron desktop app
```

Unlike the packaged Windows build (which bundles FFmpeg, Whisper, etc.), a source run uses the `ffmpeg` / `ffprobe` already on your `PATH` — so **installing FFmpeg is the one required prerequisite**. Optional features (Whisper captions, CLIP semantic search) resolve their models/binaries the same way as on Windows; the first use may download them.

> **Updating a source install:** running from source does **not** get the app's built-in auto-update — that only applies to the installed Windows binary. To update, pull and rebuild:
> ```bash
> git pull && npm run build
> ```

### Build the installer yourself

```bash
# 1. Stage the bundled binaries/models into apps/desktop/build/resources/aive
node apps/desktop/scripts/prepare-bundle.ts      # needs ffmpeg/ffprobe on PATH

# 2. Build the renderer + the NSIS installer  (output: apps/desktop/build/dist)
npm run build
npm run dist --workspace @aive/desktop
```

The bundled binaries are reused from the engine's own `~/.aive` cache when present, so the slow downloads happen at most once. The packaged app points the engine at the bundled copies via env overrides (`AIVE_FFMPEG`, `AIVE_WHISPER_BIN`, …) — the same variables you can set by hand for a source checkout.

> **Heads-up on size:** the staged bundle is ~430 MB (a static FFmpeg build is ~280 MB of it, the `base.en` model ~150 MB). Drop a leaner FFmpeg (e.g. a *shared* build) into `apps/desktop/build/resources/aive/ffmpeg/` to shrink it.

## Requirements

- **Packaged app:** none — everything needed is bundled (first run is offline).
- **From source:** Node.js ≥ 20, plus FFmpeg + ffprobe on `PATH`.

## License

**GNU General Public License v3.0 (or later)** — see [LICENSE](LICENSE). You are free to use, study, share, and modify this software; derivative works that you distribute must also be released under the GPL-3.0 and include their source. Only permissively licensed (MIT/Apache/BSD) **models** are bundled; AGPL and non-commercial models are intentionally excluded.

Bundled and downloaded third-party components, and their license obligations, are documented in **[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)**. Two points worth calling out:

- **FFmpeg** ships as a GPL build and is invoked as a separate process. Its GPL terms are compatible with this project's GPL-3.0 license; redistributing the installer still carries the usual GPL "offer the source" obligation for that binary.
- **Remotion** (motion graphics only) is **source-available, not OSI open-source** — companies of 4+ people need a paid license, and its field-of-use terms are **not** GPL-compatible. It is isolated to one optional module (`packages/core/src/motion/render.ts`) and can be swapped for a Puppeteer/Playwright renderer for a fully GPL-clean build. See `THIRD_PARTY_LICENSES.md`.
