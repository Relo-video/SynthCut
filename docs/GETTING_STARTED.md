# Getting Started

This guide gets the AI-Native Video Editor running on your machine and connected
to an AI client.

## 1. Prerequisites

- **Node.js ≥ 20** — check with `node --version`
- **FFmpeg + ffprobe on your PATH** — check with `ffmpeg -version`
  - Windows: `winget install Gyan.FFmpeg` or download from https://ffmpeg.org
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

## 2. Install & build

From the repository root:

```bash
npm install
npm run build        # builds @aive/core, @aive/mcp, and the desktop renderer
```

## 3. Launch the desktop app

```bash
npm start            # builds the renderer (if needed) and opens the editor
```

The app automatically starts the editor **core** in the background and connects
to it. You should see the Clip Library, Preview, and Timeline panels. The
connection indicator (top-right) should read `core :<port>`.

You can already use it manually: **Import** footage, add clips to the timeline,
reorder/split/trim them, **Render Preview**, and **Export**.

## 4. Connect your AI client

This is the point of the project — let the AI drive the edit. The editor is a
standard MCP server, so **any** MCP client works. Pick one (or both — they all
attach to the same shared core):

First build the project (`npm run build`) so `packages/mcp/dist/index.js` exists.

### Option A — Claude Desktop

1. Open Claude Desktop's config file:
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Merge in the `ai-video-editor` server from
   [`claude_desktop_config.example.json`](../claude_desktop_config.example.json),
   setting the path to this repo's `packages/mcp/dist/index.js`.
3. **Fully restart Claude Desktop.**

### Option B — Claude Code (CLI)

This repo already ships a project-scoped [`.mcp.json`](../.mcp.json), so the
simplest path is:

1. Run Claude Code **from the repo root** (so the relative server path resolves).
2. Approve the `ai-video-editor` server when prompted (project-scoped servers
   require a one-time approval), or run `/mcp` to check it's connected.

Prefer an explicit command instead? Register it directly (use the **absolute**
path to `index.js`):

```bash
# default scope = just you, this project
claude mcp add ai-video-editor -- node /abs/path/to/packages/mcp/dist/index.js

# or make it available everywhere:  -s user
# verify / inspect:
claude mcp list
```

Now ask Claude something like:

> Import the videos in `C:\footage\` (clip1.mp4, clip2.mp4), trim the silence at
> the start of clip1, put them back to back, make it vertical 9:16, and render a
> preview.

Claude will call the editor's MCP tools. If the desktop app is open, every edit
appears live in its timeline and you can render the preview to review. If the
app is closed, the MCP server starts a headless core on its own — open the app
afterward and it reconnects to the same session.

### How the connection works

The MCP server does **not** hold any editing state. It forwards each tool call
to the running editor core over HTTP. The desktop app talks to the same core
over WebSocket. So the AI and you operate **one shared project** — no syncing,
no conflicts.

## Available AI tools

`import_video`, `append_clip`, `insert_clip`, `trim_clip`, `split_clip`,
`cut_range`, `remove_clip`, `move_clip`, `set_project_settings`,
`render_preview`, `export_video`, `generate_thumbnail`, `analyze_silence`,
`analyze_scenes`, `timeline_summary`, `get_state`, `undo`, `redo`,
`save_project`, `load_project`, `new_project`, `remove_asset`.

Plus an `aive://guide/editing` resource (editing craft guidance) and an
`edit_brief` prompt to kick off a session.

## Troubleshooting

- **"Could not start the editor core"** — run `npm run build` at the repo root,
  and confirm `ffmpeg -version` works.
- **Claude doesn't see the tools** — make sure you fully restarted Claude
  Desktop and that the path in the config points to an existing
  `packages/mcp/dist/index.js`.
- **Preview won't play** — previews render to your data dir; ensure FFmpeg's
  `libx264` encoder is available (`ffmpeg -encoders | findstr 264`).
