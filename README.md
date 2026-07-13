<div align="center">

<img src="relo-logo.png" alt="SynthCut by Relo" width="132" height="132" />

<h1>SynthCut&nbsp;&nbsp;<sub><sup>by&nbsp;Relo</sup></sub></h1>

<h3>An open-source video editor built to be operated by&nbsp;<em>AI,&nbsp;not&nbsp;humans</em></h3>

<p>
A full multi-track, frame-based editor that exposes itself as an <b>MCP server</b> —<br/>
any MCP-compatible AI client drives real, local FFmpeg edits, fully offline.
</p>

<p>
<a href="LICENSE"><img alt="License: GPL v3" src="https://img.shields.io/badge/License-GPLv3-3b82f6.svg?style=flat-square"></a>
<img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6b7280?style=flat-square">
<img alt="MCP server" src="https://img.shields.io/badge/MCP-server-8b5cf6?style=flat-square">
<img alt="Electron + React" src="https://img.shields.io/badge/Electron-React-47848f?style=flat-square">
<img alt="85 MCP tools" src="https://img.shields.io/badge/tools-85-0ea5e9?style=flat-square">
<img alt="100% local" src="https://img.shields.io/badge/processing-100%25%20local-3ecf8e?style=flat-square">
</p>

</div>

---

Every video editor today — Premiere, DaVinci Resolve, CapCut — is designed for a person to click and drag. AI models can understand a user's creative intent perfectly, but they can't *operate* those tools. This project flips that: the AI is the primary operator. You describe the edit in plain language, the AI does it, you review and course-correct.

The editor exposes itself as an **MCP (Model Context Protocol) server**, so any MCP-compatible client — Claude Desktop or others — connects and drives it directly. All processing is **local and offline** via FFmpeg. Your footage never leaves your machine.

> **Status:** Stable. A full multi-track, frame-based editor with **85 MCP tools** — from import/cut/trim to per-clip transforms + keyframe animation, color grading, an effects stack, Whisper captions, subject-aware auto-reframe, motion graphics, media intelligence (transcript + semantic visual search), and platform export presets.

## Making social media videos? Try relo.video

SynthCut is the open-source, self-hosted engine — an AI *drives* it, but you still install it, connect an MCP client, and manage the project yourself. If you'd rather skip all of that and just get a finished Reel, TikTok, Short, or LinkedIn post, our hosted sibling **[relo.video](https://relo.video)** is built specifically for that: describe a product or idea and it generates a fully animated video (kinetic type, animated icons, voiceover, auto captions) with no footage required, or upload raw/unedited clips and it adds captions, color grading, music sync, and motion-graphics overlays for you. Editing happens by chat instead of a timeline — you ask for a change (bigger headline, slower intro) and it rebuilds the preview — and a single upload exports to vertical, square, and horizontal cuts at once. There's a free tier (100 credits, no card required) good for about two full videos.

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
- **Whisper (whisper.cpp)** — local speech-to-text for captions.
- **Remotion** — AI-authored React components for motion graphics.
- **MCP server** — clean tool definitions any MCP client can call.
- **Electron + React** — desktop UI: timeline, clip library, preview.

## Repository layout

```
packages/core             @aive/core — headless editing engine + WebSocket server
packages/mcp              @aive/mcp  — MCP server exposing editor tools to AI clients
packages/skill-installer  @relo-video/synthcut — `npx @relo-video/synthcut add`: installs the pro-editor AI skill
apps/desktop                         — Electron + React desktop UI
```

## Features

A full multi-track, frame-based editing workstation. Every capability is exposed as an MCP tool — and each tool is simultaneously an AI action *and* a UI action, defined exactly once in the core's RPC registry:

- **Editing** — import, cut / trim / split / concat / reorder, multi-track timeline, ripple edits, undo/redo.
- **Framing** — reframe (9:16 / 1:1 / 16:9) + crop, subject-tracking auto-reframe, stabilization.
- **Motion** — per-clip transforms with keyframe animation, native keyframe-animated text.
- **Color** — grading (wheels / curves / white-balance), LUTs, and a stackable effects chain.
- **Audio** — speed ramps, fades, crossfade transitions, background music + ducking, J/L audio cuts.
- **Captions & graphics** — Whisper speech-to-text captions and Remotion-authored motion graphics.
- **Media intelligence** — folders, transcript indexing + search, perceptual and CLIP semantic visual search, audio sync, and a vision-based `inspect_timeline` loop for the AI.
- **Text-based editing** — word-level transcripts turn the words into the edit surface: `tighten_talk` strips filler words + long pauses in one call, `delete_transcript_ranges` cuts by word index, and `edit_by_transcript` assembles a cut from your edited script (Descript's loop, agent-driven).
- **Adjustment layers & markers** — grade a whole scene with one source-less layer; leave named, annotated markers as a human↔AI review channel.
- **Jobs & robustness** — long renders run as observable, cancelable background jobs with live progress (forwarded as MCP progress notifications); crash-recovery autosave; disk-cache GC.
- **Performance** — segment render cache (small edits re-render only the touched seconds; `get_frame` verify-loops are near-instant), fast affine transform baking, and automatic GPU encoding for previews (opt-in for exports).
- **Output** — real-time Canvas2D compositor preview, proxy media for fast preview, platform export presets with loudness normalization (-14/-16 LUFS), and sidecar SRT/VTT caption export/import.

**94 MCP tools** in total, all processing local and offline via FFmpeg.

## Interchange (OpenTimelineIO)

Start the edit with AI in SynthCut, finish anywhere: `export_otio` writes the timeline as an [OpenTimelineIO](https://opentimeline.io) `.otio` file that DaVinci Resolve, Hiero, RV and other OTIO-capable tools read — tracks, clips, gaps, dissolves and speed all map natively, and everything OTIO can't express (effect stacks, keyframes, captions, motion graphics, adjustment layers) rides in `metadata.synthcut`, so `import_otio` restores a SynthCut export **losslessly**. Importing foreign OTIO works too: referenced media is probed from disk and anything missing becomes an offline placeholder asset ready for relinking.

## Make your AI a professional editor — the `video-editor-pro` skill

Connecting an AI client to the MCP server teaches it to *operate* the editor
(the server injects its own operating manual). The **video-editor-pro skill**
is the layer above that: the professional craft — the inspect → plan → edit →
**verify with rendered frames** → export workflow, hook/pacing/caption/color/
motion-design rules, and exact tool recipes (punch-in zooms, vertical reframes,
silence cleanup, J/L cuts, music beds). With the skill installed, any capable
AI edits like someone who does it for a living.

Install it into your AI client with one command:

```bash
npx @relo-video/synthcut add        # interactive: pick your AI client, then project/global
```

Or non-interactive: `npx @relo-video/synthcut add --client claude --scope project`.
Re-run the same command later to update to the latest skill
(`npx @relo-video/synthcut@latest add` to bypass a stale npx cache).
Supported clients: **Claude Code** (`.claude/skills/`), **Cursor**
(`.cursor/rules/*.mdc`), **Codex CLI** and generic agents (`AGENTS.md`),
**Gemini CLI** (`GEMINI.md`), **Windsurf** (`.windsurf/rules/`) — each gets the
right file format and location for project or global scope. Re-running updates
in place; details in
[`packages/skill-installer/README.md`](packages/skill-installer/README.md).

From a checkout of this repo (without npm):
`node packages/skill-installer/bin/synthcut.mjs`.

> Maintainers: `npx @relo-video/synthcut` resolves once the package is published
> (`npm publish --workspace @relo-video/synthcut` — scoped, so `publishConfig.access`
> is already set to public); bump its version in lockstep with the other
> packages (see `docs/RELEASING.md`).

## Install (packaged app)

The Windows installer is **offline-first**: it bundles FFmpeg + ffprobe, whisper.cpp with the `base.en` model, the YuNet face-detection model, and an open-source font, so import/edit/export, captions, and auto-reframe all work on first launch with **no downloads**. Motion graphics (Remotion) downloads its headless Chrome the first time you use it.

1. Run **`AI-Native Video Editor <version> Setup.exe`** and follow the installer.
2. Because the build is **unsigned**, Windows SmartScreen may warn ("Windows protected your PC"). Click **More info → Run anyway**. (We can drop in an Authenticode certificate later — the config has a hook for it.)
3. To drive it with AI, connect an MCP client — see **Connect your AI client** below.

## Connect your AI client

The editor is a standard **MCP server** — any MCP-compatible client can drive it (Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI, Codex CLI, or any other MCP client). The connection is always the same shape: your client launches `packages/mcp/dist/index.js` (or, in the packaged app, its own bundled runtime), which forwards tool calls to this app's running editor core — so the AI and this window always share one live project.

**The exact, ready-to-paste config for your install is in the app itself:** click **Connect AI** (top of the window) → pick your client from the tabs → copy the snippet shown. It already has the correct absolute path and, for the packaged app, the right runtime flags filled in — no guessing paths.

If you'd rather do it by hand, or you're running from a source checkout without the desktop app open, each client expects the server registered at a different location:

| Client | Where it goes | Format |
| --- | --- | --- |
| **Claude Desktop** | `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`) | JSON `mcpServers` |
| **Claude Code (CLI)** | `claude mcp add ai-video-editor -- node <path>/packages/mcp/dist/index.js` (or use this repo's shipped [`.mcp.json`](.mcp.json) directly) | CLI command / JSON |
| **Cursor** | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | JSON `mcpServers` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | JSON `mcpServers` |
| **Gemini CLI** | `~/.gemini/settings.json` | JSON `mcpServers` |
| **Codex CLI** | `~/.codex/config.toml` | TOML `[mcp_servers.ai-video-editor]` |
| **Other** | Check your client's docs — most accept the same JSON `mcpServers` shape | JSON `mcpServers` |

All of them, in the JSON case, look like:

```json
{
  "mcpServers": {
    "ai-video-editor": {
      "command": "node",
      "args": ["<absolute path to this repo>/packages/mcp/dist/index.js"]
    }
  }
}
```

Fully restart your client after editing its config (Claude Code needs no restart — `claude mcp list` confirms it's registered). For a from-source build, see [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) and [`claude_desktop_config.example.json`](claude_desktop_config.example.json) for a worked example.

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

## Troubleshooting

### Status pill shows "Offline" / "Disconnected"

The desktop UI talks to the `core` backend (`127.0.0.1:4789` by default) over a WebSocket. The pill in the top bar turns green ("Core :4789") once that socket is open, and red ("Offline") when it's closed. The app retries the connection every second, but it reuses the port/token it launched with — it does **not** automatically pick up a new token if the core restarts, so a stuck "Offline" pill usually needs a relaunch rather than waiting it out.

**Fix, in order:**

1. **Relaunch the desktop app.** This resolves the vast majority of cases — on startup the app re-reads `~/.aive/data/server.json`, health-checks the core, and opens a fresh window with the current port + token.
2. **Check whether the core is actually running.** Open `~/.aive/data/server.json` — it contains `{ port, pid, startedAt, token }`. If that `pid` isn't a live process, the core died; relaunching will spawn a new one.
3. **Kill a wedged core.** If the `pid` is alive but not responding (e.g. `/health` times out), kill that process, then relaunch the app to spawn a fresh core.
4. **Delete a stale `server.json`.** If it points at a dead core, remove `~/.aive/data/server.json` and relaunch for a clean respawn.
5. **Port 4789 already in use by something else.** The core will fail to bind and exit before reporting "ready". Free the port, or set the `AIVE_PORT` environment variable to run the core on a different port.
6. **Check the logs.** The core has no log file — it writes to stdout/stderr only. Running from source (`npm start`), these appear in the terminal (look for `[aive-core] listening on …`, `{"event":"ready"}`, or `[aive-core] fatal:`). In the packaged app, a failed core startup shows an error dialog ("Could not start the editor core").

This most commonly happens when a **second core process** (e.g. one spawned by an MCP client) starts up and rotates the auth token while the desktop window is still open with the old one — every reconnect attempt then gets rejected. Closing and reopening the app picks up the live token again.

## License

**GNU General Public License v3.0 (or later)** — see [LICENSE](LICENSE). You are free to use, study, share, and modify this software; derivative works that you distribute must also be released under the GPL-3.0 and include their source. Only permissively licensed (MIT/Apache/BSD) **models** are bundled; AGPL and non-commercial models are intentionally excluded.

Bundled and downloaded third-party components, and their license obligations, are documented in **[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)**. Two points worth calling out:

- **FFmpeg** ships as a GPL build and is invoked as a separate process. Its GPL terms are compatible with this project's GPL-3.0 license; redistributing the installer still carries the usual GPL "offer the source" obligation for that binary.
- **Remotion** (motion graphics only) is **source-available, not OSI open-source** — companies of 4+ people need a paid license, and its field-of-use terms are **not** GPL-compatible. It is isolated to one optional module (`packages/core/src/motion/render.ts`) and can be swapped for a Puppeteer/Playwright renderer for a fully GPL-clean build. See `THIRD_PARTY_LICENSES.md`.
