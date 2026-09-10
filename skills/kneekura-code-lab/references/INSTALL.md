# KNEEKURA Code LAB Skill installation

This directory is the distributable Agent Skill surface for KNEEKURA Code LAB v1.

## What this Skill contains

The Skill package contains instructions and connection guidance only. It does not copy or fork the KNEEKURA, Understand Anything, or Archify engine implementations. The authoritative implementation remains in KNEEKURA-CODE-LAB and is reached through the MCP adapter described in `MCP.md`.

This separation is intentional: updating an Agent Skill must never silently replace analysis-engine semantics, exact-snapshot verification, engine pins, or delivery gates.

## Build the package

From the KNEEKURA-CODE-LAB repository root:

```bash
npm run skill:package
```

The deterministic outputs are written to:

```text
dist/chatgpt-skill/kneekura-code-lab/
dist/chatgpt-skill/kneekura-code-lab.zip
dist/chatgpt-skill/kneekura-code-lab.zip.sha256
```

The ZIP is byte-reproducible for the same tracked Skill inputs. `skill-distribution.json` records the allowlisted source files and their hashes.

## Connect execution

Install or enable the Skill in an Agent Skills compatible host, then connect a KNEEKURA Code LAB MCP service that exposes the tool contract in `MCP.md`.

If the MCP execution service is unavailable, the Skill must report that execution is unavailable. It must not imitate an engine result or label ordinary model reasoning as a KNEEKURA, Understand Anything, or Archify run.

For local process-spawned hosts, the repository's MCP package provides a stdio server entrypoint. A remote ChatGPT app can later expose the same adapter through an HTTP transport without changing the Skill or engine semantics.