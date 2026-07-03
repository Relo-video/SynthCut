# Contributing

Thanks for your interest in the AI-Native Video Editor! This is an open-source
project and contributions are welcome.

## Project structure

```
packages/core    @aive/core  — headless engine: timeline (EDL), FFmpeg pipeline,
                               HTTP /rpc + WebSocket server. No UI, no AI.
packages/mcp     @aive/mcp   — MCP server: exposes core's RPC methods as tools to
                               AI clients; forwards calls to the running core.
apps/desktop     @aive/desktop — Electron + React UI. Connects to core over WS.
```

The golden rule of the architecture: **the editor core is the single source of
truth.** The MCP server and the desktop UI are both thin clients of it. Add a
new editing capability **once**, in the core's RPC registry, and it is instantly
available to both the AI (as an MCP tool) and the UI.

## Adding a new editing operation

1. Implement the behavior on `EditorEngine` in `packages/core/src/engine.ts`
   (mutations should go through `this.mutate(...)` for undo support).
2. Register it in `packages/core/src/rpc.ts` with a zod schema + description.
   That's it — the MCP server auto-exposes every RPC method as a tool, and the
   UI can call `api.rpc("your_method", { ... })`.
3. If it changes rendering, update the filtergraph builder in
   `packages/core/src/ffmpeg/graph.ts`.

## Dev setup

```bash
npm install
npm run build
npm test            # see "Testing" below
```

## Testing

Every feature ships with an end-to-end smoke test that runs a **real FFmpeg
render** — there are no mocks. Generate two test clips, then run them. Smoke
arguments must be **absolute paths** (`importVideo` rejects relative ones).

```bash
# generate sample clips (any two media files work); scratch/ is gitignored
mkdir -p scratch
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30:duration=5 -f lavfi -i sine=frequency=440:duration=5 -shortest -pix_fmt yuv420p scratch/a.mp4
ffmpeg -f lavfi -i testsrc2=size=640x480:rate=30:duration=4 -pix_fmt yuv420p scratch/b.mp4

npx tsx packages/core/scripts/smoke.ts scratch/a.mp4 scratch/b.mp4   # engine + render
npx tsx packages/mcp/scripts/smoke.ts  scratch/a.mp4 scratch/b.mp4   # full MCP path
```

Per-feature smokes live in `packages/core/scripts/` — e.g. `smoke-effects.ts`,
`smoke-transitions.ts`, `smoke-music.ts`, `smoke-text.ts`, `smoke-captions.ts`
(Whisper), `smoke-reframe.ts` (YuNet), `smoke-jlcut.ts`, `smoke-motion.ts`
(Remotion), and `smoke-bundled.ts` (the packaged/offline bundle, see below).
Models/binaries download on first use and cache under `~/.aive` (override with
`AIVE_WHISPER_DIR` / `AIVE_MODELS_DIR`, etc.).

## Packaging / building installers

Distribution is **offline-first**: the installer bundles FFmpeg, whisper.cpp
(+ `base.en`), the YuNet model, and an OSS font so the app works with no
downloads on first run. Remotion's headless Chrome is the one exception — it
downloads on first motion-graphics use.

```bash
node apps/desktop/scripts/prepare-bundle.ts     # stage bundled binaries → apps/desktop/build/resources/aive
npx tsx packages/core/scripts/smoke-bundled.ts  # verify the staged bundle renders offline
npm run build
npm run dist --workspace @aive/desktop          # build the NSIS installer
```

A few non-obvious things if you touch the packaging:

- `apps/desktop/electron/bundled-assets.cjs` sets the engine's env overrides
  (`AIVE_FFMPEG`, `AIVE_WHISPER_BIN`, …) to the bundled copies — but **only when
  `app.isPackaged`**. In dev it's a no-op and the engine uses PATH + `~/.aive`.
- The electron-builder config sets **`npmRebuild: false`**. Without it,
  electron-builder runs a production `npm install` that, in this hoisted npm
  workspace, **prunes devDependencies from the shared root `node_modules`** — it
  will delete electron-builder itself mid-build. Leave it off.
- `asar: false` is intentional: the core runs as a spawned Node subprocess and
  Remotion's bundler needs real filesystem access to `node_modules`.
- On Windows, electron-builder's `winCodeSign` archive contains macOS symlinks
  that can't be created without Developer Mode/admin. If extraction fails,
  pre-extract it once into
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` (the two
  failed `.dylib` symlinks are macOS-only and unused on Windows).

## Licensing rules for dependencies

This project is GPL-3.0 and must stay free for everyone to build on. When adding
dependencies — **especially ML models** — only permissive licenses are allowed:

- ✅ MIT / Apache-2.0 / BSD
- ❌ **AGPL** (e.g. Ultralytics YOLO) or non-commercial / research-only weights

FFmpeg is invoked as an external process (never linked), so its GPL/LGPL
components don't affect our license.

**One accepted exception:** Remotion (motion graphics) is *source-available*, not
OSI open-source, and is a *linked* dependency. It is deliberately isolated to
`packages/core/src/motion/render.ts` so it can be swapped for a
Puppeteer/Playwright renderer. Don't add new source-available/commercial deps
without the same isolation + a clear reason. Every bundled or downloaded
component must be listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Style

- TypeScript everywhere, `strict` mode.
- Keep the core free of UI/AI concerns; keep transports (MCP, WS) thin.
- No placeholders — every contribution should actually work end-to-end.
