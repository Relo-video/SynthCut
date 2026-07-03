import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, selectComposition, renderMedia } from "@remotion/renderer";

/**
 * Headless motion-graphics renderer (Remotion).
 *
 * The AI authors a React/Remotion component as TSX (the `code`); we scaffold a
 * minimal Remotion project around it, bundle it (Remotion's webpack), and render
 * it to a standalone video. For OVERLAY graphics we render ProRes 4444, which
 * carries an alpha channel, so the result can be composited over footage by
 * FFmpeg's `overlay` filter (see ffmpeg/graph.ts). For STANDALONE cards the
 * component fills its own background, so alpha is irrelevant.
 *
 * Remotion drives a headless Chrome ("Chrome Headless Shell") which is
 * downloaded on first use and cached by Remotion (like our whisper/YuNet
 * binaries) — see ensureBrowser().
 *
 * NOTE on licensing: Remotion is source-available under the Remotion License
 * (not OSI open-source); companies of 4+ people need a paid license. It is the
 * only such dependency in the project and is isolated to this module. See
 * docs/PROJECT_STATUS.md / THIRD_PARTY notes.
 */

export interface RenderGraphicOptions {
  /** AI-authored TSX module that default-exports a React component. */
  code: string;
  /** Props passed to the component. */
  props?: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /**
   * Absolute output path. For an alpha overlay this should end in .mov (ProRes
   * 4444 with alpha); for an opaque standalone graphic it should end in .mp4.
   */
  outPath: string;
  /**
   * Keep an alpha channel (ProRes 4444 .mov) so the graphic can be composited
   * over footage. Default true. Set false for a STANDALONE graphic that fills
   * its own background — it renders to an opaque H.264 .mp4 instead, which (a)
   * the Electron/Chromium preview player can actually decode (ProRes cannot be
   * played in a browser <video>, so a standalone ProRes clip shows as black in
   * the live preview) and (b) is smaller.
   */
  alpha?: boolean;
  /** Unique scratch directory to scaffold the Remotion project in. */
  workDir: string;
  /** Optional progress callback, 0..1. */
  onProgress?: (fraction: number) => void;
}

const req = createRequire(import.meta.url);

/** node_modules dir that resolves `react`/`remotion` for the bundler. */
function nodeModulesDir(): string {
  // .../node_modules/react/package.json -> .../node_modules
  return dirname(dirname(req.resolve("react/package.json")));
}

/**
 * Find a free TCP port for Remotion's internal bundle server. Remotion defaults
 * to port 3000, which collides with common dev servers (Next.js etc.) — when it
 * does, it can connect to the foreign server instead of its own bundle. Binding
 * an OS-assigned ephemeral port avoids that entirely.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Generate the Remotion Root that registers the AI component as a composition. */
function rootSource(o: RenderGraphicOptions): string {
  return `import React from "react";
import { Composition } from "remotion";
import Graphic from "./Graphic";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Graphic"
      component={Graphic as unknown as React.FC}
      durationInFrames={${Math.max(1, Math.round(o.durationInFrames))}}
      fps={${o.fps}}
      width={${Math.round(o.width)}}
      height={${Math.round(o.height)}}
      defaultProps={${JSON.stringify(o.props ?? {})} as Record<string, unknown>}
    />
  );
};
`;
}

const ENTRY_SOURCE = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;

/**
 * Render an AI-authored Remotion component to an alpha video file. The scaffold
 * is written under `workDir`, bundled, rendered, and then cleaned up.
 */
export async function renderGraphic(opts: RenderGraphicOptions): Promise<void> {
  await mkdir(opts.workDir, { recursive: true });
  await writeFile(join(opts.workDir, "Graphic.tsx"), opts.code, "utf8");
  await writeFile(join(opts.workDir, "Root.tsx"), rootSource(opts), "utf8");
  await writeFile(join(opts.workDir, "index.ts"), ENTRY_SOURCE, "utf8");

  const modulesDir = nodeModulesDir();

  try {
    const serveUrl = await bundle({
      entryPoint: join(opts.workDir, "index.ts"),
      // The scaffold lives outside the repo's node_modules tree, so point
      // webpack at the installed node_modules so `react`/`remotion`/the AI's
      // imports resolve.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [modulesDir, ...((config.resolve && config.resolve.modules) || ["node_modules"])],
        },
      }),
    });

    // Downloads Chrome Headless Shell on first use (cached by Remotion).
    await ensureBrowser();

    const inputProps = opts.props ?? {};
    const port = await freePort();
    const composition = await selectComposition({ serveUrl, id: "Graphic", inputProps, port });

    const alpha = opts.alpha !== false;
    await renderMedia({
      composition,
      serveUrl,
      port,
      // Alpha overlay: ProRes 4444 keeps an alpha channel so the graphic can be
      // composited over footage (transparent wherever the component doesn't
      // paint). This needs BOTH an alpha-carrying pixelFormat AND PNG frames —
      // the default JPEG frames have no alpha, so Remotion silently falls back to
      // an opaque 4:2:2 format and transparent regions bake to black. Standalone:
      // opaque H.264 the preview player can decode.
      ...(alpha
        ? ({ codec: "prores", proResProfile: "4444", pixelFormat: "yuva444p10le", imageFormat: "png" } as const)
        : ({ codec: "h264", pixelFormat: "yuv420p" } as const)),
      outputLocation: opts.outPath,
      inputProps,
      onProgress: opts.onProgress ? ({ progress }) => opts.onProgress!(progress) : undefined,
    });
  } finally {
    // Best-effort cleanup of the scaffold (the bundle lives in a temp dir
    // Remotion manages; the scaffold is ours).
    await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
