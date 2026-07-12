#!/usr/bin/env node
/**
 * synthcut — installer for the SynthCut "video-editor-pro" AI skill.
 *
 *   npx synthcut                 interactive: pick client + scope
 *   npx synthcut add --client claude --scope project
 *   npx synthcut add --client codex  --scope global --force
 *   ("skill" and "install" are accepted aliases for "add")
 *
 * The skill itself is one markdown file (skill/SKILL.md in this package).
 * What differs per AI client is WHERE it lives and what wrapper it needs;
 * this CLI owns that mapping so users never have to.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const SKILL_NAME = "video-editor-pro";
const MARK_START = `<!-- synthcut:${SKILL_NAME}:start -->`;
const MARK_END = `<!-- synthcut:${SKILL_NAME}:end -->`;

const CLIENTS = {
  claude: "Claude Code (skill file)",
  cursor: "Cursor (project rule)",
  codex: "Codex CLI (AGENTS.md)",
  gemini: "Gemini CLI (GEMINI.md)",
  windsurf: "Windsurf (rules file)",
  agents: "Other / generic agent (AGENTS.md)",
};
const SCOPES = { project: "This project only", global: "Global (all projects, this machine)" };

// ---------------------------------------------------------------- skill text

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");
const rawSkill = readFileSync(skillPath, "utf8");

/** Split the Claude-style frontmatter off the markdown body. */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { description: "", body: text };
  const desc = /description:\s*([\s\S]*?)(?:\r?\n\w|$)/.exec(m[1]);
  return { description: (desc?.[1] ?? "").replace(/\s+/g, " ").trim(), body: text.slice(m[0].length) };
}

// ------------------------------------------------------------------ plumbing

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--client") args.client = argv[++i];
    else if (a === "--scope") args.scope = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function pick(rl, title, options) {
  const keys = Object.keys(options);
  console.log(`\n${title}`);
  keys.forEach((k, i) => console.log(`  ${i + 1}. ${options[k]}`));
  for (;;) {
    const answer = (await rl.question("> ")).trim();
    const idx = Number(answer) - 1;
    if (keys[idx]) return keys[idx];
    if (options[answer]) return answer;
    console.log(`Enter 1-${keys.length}.`);
  }
}

function writeFileSafe(path, content, force) {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists. Re-run with --force to overwrite.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** Insert/replace a marked SynthCut section inside a shared file (AGENTS.md/GEMINI.md). */
function upsertSection(path, body) {
  const section = `${MARK_START}\n\n${body.trim()}\n\n${MARK_END}\n`;
  let out;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
    out = re.test(cur) ? cur.replace(re, section) : `${cur.trimEnd()}\n\n${section}`;
  } else {
    out = section;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out, "utf8");
  return path;
}

// ------------------------------------------------------------------- install

function install(client, scope, projectDir, force) {
  const home = homedir();
  const { description, body } = splitFrontmatter(rawSkill);

  switch (client) {
    case "claude": {
      const base = scope === "global" ? join(home, ".claude") : join(projectDir, ".claude");
      return writeFileSafe(join(base, "skills", SKILL_NAME, "SKILL.md"), rawSkill, force);
    }
    case "cursor": {
      if (scope === "global") {
        console.log(
          "\nCursor has no global rules directory. Open Cursor → Settings → Rules →" +
            " 'User Rules' and paste the contents of the skill there.\n" +
            `Skill source: ${skillPath}`,
        );
        return null;
      }
      const mdc = `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}`;
      return writeFileSafe(join(projectDir, ".cursor", "rules", `synthcut-${SKILL_NAME}.mdc`), mdc, force);
    }
    case "codex":
      return upsertSection(
        scope === "global" ? join(home, ".codex", "AGENTS.md") : join(projectDir, "AGENTS.md"),
        body,
      );
    case "gemini":
      return upsertSection(
        scope === "global" ? join(home, ".gemini", "GEMINI.md") : join(projectDir, "GEMINI.md"),
        body,
      );
    case "windsurf": {
      if (scope === "global") {
        console.log(
          "\nWindsurf global rules live in the app (Settings → Cascade → Memories & Rules)." +
            ` Paste the skill there.\nSkill source: ${skillPath}`,
        );
        return null;
      }
      return writeFileSafe(join(projectDir, ".windsurf", "rules", `synthcut-${SKILL_NAME}.md`), body, force);
    }
    case "agents":
      return upsertSection(
        scope === "global" ? join(home, "AGENTS.md") : join(projectDir, "AGENTS.md"),
        body,
      );
    default:
      throw new Error(`Unknown client "${client}". Valid: ${Object.keys(CLIENTS).join(", ")}`);
  }
}

// ---------------------------------------------------------------------- main

const HELP = `synthcut — install the SynthCut video-editor-pro AI skill

Usage:
  synthcut [add] [--client <name>] [--scope <project|global>] [--dir <path>] [--force]

Options:
  --client   ${Object.keys(CLIENTS).join(" | ")}
  --scope    project | global
  --dir      target project directory (default: current directory)
  --force    overwrite an existing skill/rule file
  -h, --help show this help

Run with no flags for interactive prompts.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cmd = args._[0] ?? "add";
  if (!["add", "skill", "install"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  let { client, scope } = args;
  if (!client || !scope) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("SynthCut skill installer — makes your AI a professional video editor.");
    client ??= await pick(rl, "Which AI client?", CLIENTS);
    scope ??= await pick(rl, "Install where?", SCOPES);
    rl.close();
  }
  if (!SCOPES[scope]) throw new Error(`Unknown scope "${scope}". Valid: project, global`);

  const projectDir = resolve(args.dir ?? process.cwd());
  const written = install(client, scope, projectDir, args.force ?? false);
  if (written) {
    console.log(`\n✔ Installed ${SKILL_NAME} for ${CLIENTS[client]} (${scope}):\n  ${written}`);
    console.log("Restart/reload your AI client to pick it up.");
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exitCode = 1;
});
