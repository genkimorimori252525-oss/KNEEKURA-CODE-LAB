# KNEEKURA Code LAB MCP Adapter v1

## Purpose

This adapter makes the completed KNEEKURA Code LAB v1 orchestration boundary available to MCP hosts without introducing a fourth semantic engine or copying existing engine logic.

The adapter has two layers:

- `mcp/src/adapter.mjs` — transport-neutral validation and result projection.
- `mcp/src/server.mjs` — MCP TypeScript SDK v2 stdio transport registration.

`mcp/src/in-process-backend.mjs` is the bridge back into the existing `executeKneekuraCodeLabRequest()` runtime. A host supplies `createEngineRunners()` so KNEEKURA production semantic authoring, Understand Anything native role scheduling, and Archify typed-IR authoring remain explicit host capabilities.

## Why the backend is injected

KNEEKURA Code LAB v1 deliberately separates deterministic repository evidence/verification from semantic authoring. The native KNEEKURA engine requires an explicit production semantic-author host; Understand Anything requires isolated semantic role scheduling; Archify requires typed IR authoring. The MCP server therefore does not secretly embed another model, acceptance fixture, or fallback author.

If no backend module is configured, `describe` and `plan` work and `execute` fails closed with `BLOCKED_BACKEND_UNAVAILABLE`.

## Exact-target request

Every executable MCP request contains:

```json
{
  "selection": "kneekura",
  "target": {
    "repository": "owner/repository",
    "revision": "<exact 40- or 64-hex Git revision>",
    "snapshotId": "snapshot:sha256:<64 hex>",
    "scopeDigest": "sha256:<64 hex>"
  },
  "runId": "safe-run-id",
  "commonScope": {},
  "engineOptions": {},
  "minimumClaimLevel": {}
}
```

The adapter validates the shape and the canonical identity formats. The configured backend must still prove that the supplied snapshot actually corresponds to the exact repository/revision before constructing engine runners.

## Bounded MCP projection

Tool results intentionally exclude:

- raw source,
- unrestricted stdout/stderr,
- engine-private semantic context,
- delivery ZIP bytes,
- host filesystem paths,
- credentials/environment dumps.

Direct-engine results expose the sanitized engine receipt and sealed artifact identity. All-mode exposes only the run manifest, operational comparison, per-engine operational outcomes, and bundle digest/size.

## Local launch

Install the pinned MCP package dependencies:

```bash
npm install --prefix mcp --ignore-scripts --no-audit --no-fund
```

Configure an operator-owned backend module if execution is required:

```text
KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE=<path-to-backend-module>
```

Then run:

```bash
npm --prefix mcp start
```

The backend module may export either `backend` or an async `createBackend()` function. Target repository content must never control this module path.

## Remote ChatGPT path

A future remote ChatGPT/Apps SDK transport should wrap the same transport-neutral adapter. Remote HTTP, authentication, tenancy, artifact hosting, and deployment policy are separate from analysis-engine semantics and are intentionally not hidden inside v1.