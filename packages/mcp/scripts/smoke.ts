/**
 * End-to-end MCP smoke test. Boots an in-process core, then connects a real MCP
 * client over stdio to our MCP server (exactly as Claude Desktop would), lists
 * tools, and drives a full edit -> export through the protocol.
 *
 * Run: npx tsx packages/mcp/scripts/smoke.ts <clipA> <clipB>
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { EditorEngine, EditorServer } from "@aive/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ToolText {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parse(result: ToolText): any {
  if (result.isError) throw new Error(`tool error: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text!);
}

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-mcp-"));

  // 1. Boot the core in-process.
  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port: 0, dataDir });
  const port = await server.start();
  const coreUrl = `http://127.0.0.1:${port}`;
  console.log(`1. core listening at ${coreUrl}`);

  // 2. Connect an MCP client to our MCP server over stdio.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/mcp/dist/index.js"],
    env: { ...process.env, AIVE_CORE_URL: coreUrl, AIVE_DATA_DIR: dataDir },
  });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
  console.log("2. MCP client connected");

  // 3. List tools.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log(`3. ${tools.length} tools exposed; sample: ${names.slice(0, 6).join(", ")}...`);
  for (const required of ["import_video", "append_clip", "cut_range", "export_video", "render_preview"]) {
    if (!names.includes(required)) throw new Error(`missing tool: ${required}`);
  }

  // 4. Read the editorial guide resource.
  const guide = await client.readResource({ uri: "aive://guide/editing" });
  console.log(`4. editing-guide resource: ${(guide.contents[0]!.text as string).length} chars`);

  // 5. Drive an edit through MCP tools.
  const a = parse((await client.callTool({ name: "import_video", arguments: { path: clipA } })) as ToolText);
  const b = parse((await client.callTool({ name: "import_video", arguments: { path: clipB } })) as ToolText);
  console.log(`5. imported A=${a.asset.id} (${a.asset.duration}s), B=${b.asset.id} (${b.asset.duration}s)`);

  const c1 = parse((await client.callTool({ name: "append_clip", arguments: { assetId: a.asset.id } })) as ToolText);
  await client.callTool({ name: "append_clip", arguments: { assetId: b.asset.id } });
  // cut_range is frame-based (30fps default canvas): cut 1s–2s = frames 30–60.
  parse((await client.callTool({ name: "cut_range", arguments: { clipId: c1.clip.id, startFrame: 30, endFrame: 60 } })) as ToolText);

  const summary = parse((await client.callTool({ name: "timeline_summary", arguments: {} })) as ToolText);
  const clipCount = summary.tracks.reduce((n: number, t: { clips: unknown[] }) => n + t.clips.length, 0);
  console.log(`6. timeline: ${clipCount} clips, ${summary.totalDuration}s total`);

  // 6. Export through MCP.
  const out = join(dataDir, "mcp-out.mp4");
  const exported = parse((await client.callTool({ name: "export_video", arguments: { outputPath: out } })) as ToolText);
  const info = await stat(exported.path);
  console.log(`7. exported via MCP: ${exported.path} (${info.size} bytes, ${exported.duration}s)`);

  // cut_range split clip A into two remainders (its duration minus the 1s cut)
  // + clip B = 3 clips, (A - 1) + B seconds total.
  const expected = a.asset.duration - 1 + b.asset.duration;
  if (clipCount !== 3) throw new Error(`expected 3 clips, got ${clipCount}`);
  if (Math.abs(summary.totalDuration - expected) > 0.2)
    throw new Error(`expected ~${expected.toFixed(2)}s, got ${summary.totalDuration}`);
  if (info.size < 1000) throw new Error("export file is too small");

  await client.close();
  await server.stop();
  console.log("\nMCP SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("MCP SMOKE TEST FAILED:", err);
  process.exit(1);
});
