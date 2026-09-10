# KNEEKURA Code LAB Plugin v1

This directory is the source template for the local/Codex/Desktop plugin distribution. The deterministic packager copies the canonical `skills/kneekura-code-lab` Skill and emits the bundled MCP server as `mcp/server.mjs`.

## Surface

- `.codex-plugin/plugin.json` — native OpenAI/Codex plugin manifest.
- `.mcp.json` — bundled stdio MCP declaration. The server key deliberately uses underscores (`kneekura_code_lab`) and `cwd: "."` so the installed plugin root is the launch root.
- `skills/kneekura-code-lab/` — copied from the canonical Skill source at package time.
- `mcp/server.mjs` — generated standalone MCP transport bundle containing the production Host Bridge backend and first-party KNEEKURA execution path.

## Execution

With no backend override configured, the Plugin starts its embedded production Host Bridge backend. KNEEKURA direct execution can therefore enter the typed Host Task → bounded source read → semantic response → deterministic replay loop without a separately installed backend module.

Understand Anything and Archify remain pinned external engines. Their exact upstream roots/artifacts are not copied into this Plugin and must be available through the documented KNEEKURA environment bindings. Missing or unsafe upstream capability is reported explicitly as BLOCKED; it is never replaced with ordinary model reasoning or another engine.

`KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE` remains an explicit override for a compatible custom backend.

## Safety boundary

The plugin is read-oriented and does not execute target repository builds, tests, installers, hooks, or binaries merely to analyze a repository. Repository bytes returned through Host Bridge source reads are untrusted data with no instruction authority. Semantic Host Responses cannot mutate the canonical Target Snapshot, waive engine validation, substitute engine identity, or promote engine consensus into canonical truth.

A command-based local MCP declaration can be treated as Desktop-only by ChatGPT web. The standalone Skill can remain installed separately on surfaces where local plugin MCP execution is unavailable.