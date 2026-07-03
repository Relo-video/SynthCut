#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { methods } from "@aive/core/rpc";
import { CoreClient } from "./core-client.js";
import { EDITING_GUIDE, PLATFORM_INSTRUCTIONS, PLATFORM_PRESETS } from "./guide.js";

/**
 * The MCP server. It does NOT hold editing state — it forwards every tool call
 * to the editor core over HTTP, so the AI and the desktop UI act on one shared
 * project. Launched over stdio by an MCP client (e.g. Claude Desktop).
 */

// Tools that only read state / analyze — hint this to clients.
const READ_ONLY = new Set([
  "get_state", "timeline_summary", "analyze_silence", "analyze_scenes", "generate_thumbnail", "get_frame",
]);

// Tools whose result `{ path }` is an image file we should hand back to the
// model as an actual image (so it can SEE the frame, not just a file path).
const IMAGE_TOOLS = new Set(["get_frame", "generate_thumbnail", "inspect_timeline", "inspect_clip"]);

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function textResult(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function imageBlock(path: string): Promise<ResultContent> {
  const mimeType = IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png";
  const data = (await readFile(path)).toString("base64");
  return { type: "image", data, mimeType };
}

async function imageResult(name: string, result: unknown) {
  // The image path(s) live under `path` (get_frame/generate_thumbnail), `frame`
  // (inspect_timeline, alongside a `summary`), or `frames: string[]`
  // (inspect_clip, alongside structured clip info). Surface the structured fields
  // as text and each frame as an inline image so the model can SEE the footage.
  const r = result as { path?: string; frame?: string; frames?: string[]; summary?: unknown };
  try {
    const content: ResultContent[] = [];
    if (Array.isArray(r?.frames) && r.frames.length) {
      const { frames, ...rest } = r as Record<string, unknown>;
      content.push({ type: "text", text: `${name}:\n${JSON.stringify(rest, null, 2)}` });
      for (const f of frames as string[]) content.push(await imageBlock(f));
      return { content };
    }
    const path = r?.path ?? r?.frame;
    if (!path) return textResult(result);
    if (r.summary !== undefined) content.push({ type: "text", text: JSON.stringify(r.summary, null, 2) });
    content.push({ type: "text", text: `${name} → rendered frame (${path}):` });
    content.push(await imageBlock(path));
    return { content };
  } catch {
    // Fall back to the path text if any frame file can't be read.
    return textResult(result);
  }
}

async function main(): Promise<void> {
  const core = new CoreClient();
  await core.connect();

  const server = new McpServer(
    {
      name: "ai-native-video-editor",
      version: "0.1.0",
    },
    {
      // Handed to the client as the server's instructions so the model learns
      // how to operate this editor every session (the channel clients reliably
      // surface), instead of relying on it to fetch the guide resource.
      instructions: PLATFORM_INSTRUCTIONS,
    },
  );

  // Register every core RPC method as an MCP tool, reusing its zod schema so
  // the tool contract and the engine never drift apart.
  for (const [name, def] of Object.entries(methods)) {
    const shape = (def.schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: shape,
        annotations: READ_ONLY.has(name)
          ? { readOnlyHint: true }
          : { readOnlyHint: false, destructiveHint: name === "remove_clip" || name === "remove_asset" },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await core.rpc(name, args ?? {});
          return IMAGE_TOOLS.has(name) ? await imageResult(name, result) : textResult(result);
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
    );
  }

  // Expose the editorial knowledge layer as a readable resource.
  server.registerResource(
    "editing-guide",
    "aive://guide/editing",
    {
      title: "Editing Guide",
      description: "How to operate this editor and edit with professional craft.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: EDITING_GUIDE }],
    }),
  );

  // A prompt template to kick off an editing session from a plain-language brief.
  server.registerPrompt(
    "edit_brief",
    {
      description: "Start an editing session from a plain-language description of the desired video.",
      argsSchema: {
        goal: z.string().describe("What the user wants, e.g. 'a 30s highlight reel, punchy, vertical'"),
        platform: z.enum(["vertical", "widescreen", "square"]).optional().describe("Target platform/aspect ratio"),
      },
    },
    ({ goal, platform }) => {
      const preset = platform ? PLATFORM_PRESETS[platform] : undefined;
      const presetLine = preset
        ? `\n\nTarget format: ${preset.label}. Call set_project_settings with width=${preset.width}, height=${preset.height} before exporting.`
        : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `You are operating the AI-Native Video Editor via its MCP tools. ` +
                `First read the resource aive://guide/editing for editing craft. ` +
                `Then accomplish this brief:\n\n${goal}${presetLine}\n\n` +
                `Import the user's footage, analyze it, build and refine the timeline, render a preview for review, then export when approved.`,
            },
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[aive-mcp] ready (stdio). Core:", core.url);

  const shutdown = () => {
    core.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[aive-mcp] fatal:", err);
  process.exit(1);
});
