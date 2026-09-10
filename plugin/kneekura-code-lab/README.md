# KNEEKURA Code LAB Plugin v1

This directory is the source template for the local/Codex/Desktop plugin distribution. The deterministic packager copies the canonical `skills/kneekura-code-lab` Skill and emits the bundled MCP server as `mcp/server.mjs`.

## Surface

- `.codex-plugin/plugin.json` — native OpenAI/Codex plugin manifest.
- `.mcp.json` — bundled stdio MCP declaration. The server key deliberately uses underscores (`kneekura_code_lab`) and `cwd: "."` so the installed plugin root is the launch root.
- `skills/kneekura-code-lab/` — copied from the canonical Skill source at package time.
- `mcp/server.mjs` — generated standalone MCP transport bundle at package time.

## Safety boundary

The plugin is read-oriented and does not execute target repository builds, tests, installers, hooks, or binaries merely to analyze a repository. It does not invent an execution backend. If the frozen KNEEKURA Code LAB engine backend is unavailable, execution fails closed instead of relabeling ordinary model reasoning as a KNEEKURA, Understand Anything, or Archify run.

A command-based local MCP declaration can be treated as Desktop-only by ChatGPT web. The standalone Skill can remain installed separately on surfaces where local plugin MCP execution is unavailable.