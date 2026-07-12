# @relo-video/synthcut — skill installer

Installs the SynthCut **video-editor-pro** skill into your AI client, so the AI
that drives the [SynthCut MCP editor](../../README.md) edits like a professional:
inspect → plan → edit → verify → export, plus caption/color/motion-design craft
rules and exact tool recipes.

```bash
npx @relo-video/synthcut add        # interactive: pick your AI client + project/global
```

Non-interactive:

```bash
npx @relo-video/synthcut add --client claude --scope project
npx @relo-video/synthcut add --client codex  --scope global
npx @relo-video/synthcut add --client cursor --scope project --force
```

(No subcommand does the same thing; `skill`/`install` are aliases for `add`.
Re-run the same command any time to get the latest skill — use
`npx @relo-video/synthcut@latest add` to bypass a stale npx cache.)

| `--client` | project install | global install |
|---|---|---|
| `claude` (Claude Code) | `.claude/skills/video-editor-pro/SKILL.md` | `~/.claude/skills/video-editor-pro/SKILL.md` |
| `cursor` | `.cursor/rules/synthcut-video-editor-pro.mdc` | prints paste-in instructions (Cursor has no global rules dir) |
| `codex` | `AGENTS.md` (marked section) | `~/.codex/AGENTS.md` |
| `gemini` | `GEMINI.md` (marked section) | `~/.gemini/GEMINI.md` |
| `windsurf` | `.windsurf/rules/synthcut-video-editor-pro.md` | prints paste-in instructions |
| `agents` (generic) | `AGENTS.md` (marked section) | `~/AGENTS.md` |

Shared files (`AGENTS.md`/`GEMINI.md`) get a marked `<!-- synthcut:… -->` section
that re-running the installer updates in place; standalone files need `--force`
to overwrite.

The canonical skill lives at [`skill/SKILL.md`](skill/SKILL.md). The repo's
`.claude/skills/video-editor-pro/SKILL.md` is a mirror for developing in this
repo — keep the two in sync when editing the skill.
