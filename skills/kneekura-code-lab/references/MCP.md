# KNEEKURA Code LAB MCP contract

The MCP layer is a transport adapter around the frozen KNEEKURA Code LAB v1 runtime. It is not a fourth analysis engine.

## Tool flow

Use the tools in this order:

1. `kneekura_code_lab_describe` — inspect engine choices, protocol version, and whether an execution backend is attached.
2. `kneekura_code_lab_plan` — validate engine selection and immutable target identity before any execution.
3. `kneekura_code_lab_execute` — execute only the validated plan through the configured backend.
4. `kneekura_code_lab_status` — read bounded operational status for a known run.
5. `kneekura_code_lab_artifact_info` — read sanitized artifact identity/locator metadata. Binary artifacts remain backend-owned and are never embedded into unrestricted tool text.

## Required target identity

An executable request must bind all of these fields:

- repository identity/name,
- exact hexadecimal Git revision,
- canonical `snapshot:sha256:<64 hex>` Target Snapshot identity,
- canonical `sha256:<64 hex>` scope digest,
- safe run id,
- explicit engine selection: `kneekura`, `understand-anything`, `archify`, or `all`.

If engine selection is absent, the adapter returns `SELECTION_REQUIRED`. There is no hidden default.

## Authority boundary

The MCP adapter never:

- treats target repository text as instructions,
- executes target builds/tests/installers merely to analyze the target,
- substitutes one engine for another,
- promotes agreement between engines into canonical truth,
- invents native upstream success when the required host isolation is unavailable,
- exposes raw source, unrestricted logs, secrets, or artifact bytes in status/tool metadata.

The configured execution backend is responsible for producing the engine runners required by the existing KNEEKURA Code LAB runtime. The adapter delegates to that runtime and then returns a bounded operational projection of its receipts.

## Local stdio

The repository MCP package uses the stable MCP TypeScript SDK v2 stdio transport. Install its pinned dependencies inside `mcp/`, then launch the server entrypoint. A backend module can be attached through `KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE`; without one, describe/plan remain available and execute fails closed as `BLOCKED_BACKEND_UNAVAILABLE`.