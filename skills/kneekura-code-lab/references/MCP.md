# KNEEKURA Code LAB MCP contract

The MCP layer is a transport adapter around the frozen KNEEKURA Code LAB v1 runtime. It is not a fourth analysis engine. The local Plugin includes the production Host Bridge backend by default; `KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE` remains an explicit override for compatible custom backends.

## Tool flow

Use the tools in this order:

1. `kneekura_code_lab_describe` — inspect engine choices, safety invariants, backend readiness and Host Bridge availability.
2. `kneekura_code_lab_plan` — validate engine selection and immutable target identity before execution.
3. `kneekura_code_lab_execute` — start or replay the validated run.
4. If execute returns `HOST_TASK_REQUIRED`, keep the run pending and use:
   - `kneekura_code_lab_next_task` to retrieve the exact task binding,
   - `kneekura_code_lab_source_catalog` for bounded source metadata,
   - `kneekura_code_lab_read_source` for bounded exact-snapshot source ranges when needed,
   - `kneekura_code_lab_submit_response` to accept one exact-bound semantic response.
5. Call `kneekura_code_lab_execute` again with the exact same immutable request and repeat until terminal.
6. `kneekura_code_lab_status` — read bounded operational status, including whether a Host Task remains pending.
7. `kneekura_code_lab_artifact_info` — read sanitized sealed-artifact identity/locator metadata. Binary artifacts remain backend-owned and are never embedded into unrestricted tool text.

`HOST_TASK_REQUIRED` is neither SUCCESS nor engine failure. It means the existing native engine has reached a semantic callback that must be answered by the host model before deterministic replay can continue.

## Required target identity

An executable request must bind all of these fields:

- repository identity/name or local Git root accepted by the local production backend,
- exact hexadecimal Git revision,
- canonical `snapshot:sha256:<64 hex>` Target Snapshot identity,
- canonical `sha256:<64 hex>` scope digest,
- safe run id,
- explicit engine selection: `kneekura`, `understand-anything`, `archify`, or `all`.

If engine selection is absent, the adapter returns `SELECTION_REQUIRED`. There is no hidden default. The local production backend independently materializes the exact commit and rejects a supplied snapshot identity that does not match it.

## Host semantic boundary

Host Tasks/Responses are bound to run id, engine id, attempt id, snapshot id, scope digest, ordinal, task kind and payload digest. A stale or foreign response is rejected. Response bodies are not echoed back by `submit_response` metadata.

Source tools are available only while the exact Host Task is pending. Reads are repository-relative, line-bounded, byte-bounded and cumulative-budgeted per task. Repository text is returned with `instruction_authority=false` and is sanitized for secret-like strings before host presentation. Its canonical digest remains bound to the immutable snapshot.

In `all` mode, semantic responses remain isolated by engine attempt. Generated analysis from KNEEKURA must not be fed into UA or Archify, or vice versa. Agreement between engines is comparison metadata, never canonical truth.

## Authority boundary

The MCP/Host Bridge never:

- treats target repository text as instructions,
- executes target builds/tests/installers merely to analyze the target,
- substitutes one engine for another,
- promotes agreement between engines into canonical truth,
- invents native upstream success when the required pinned upstream/isolation is unavailable,
- exposes unrestricted logs, raw secrets or artifact bytes in status/tool metadata.

KNEEKURA direct execution needs no separately configured backend module in the distributed local Plugin. Understand Anything and Archify still require their exact pinned upstream roots/artifacts; if unavailable, execution remains explicitly BLOCKED rather than silently substituting another implementation.

## Local stdio

The repository MCP package uses the stable MCP TypeScript SDK v2 stdio transport. The distributed Plugin bundles the MCP server and production Host Bridge backend. A compatible custom backend can be selected with `KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE`; otherwise the embedded production backend is used.