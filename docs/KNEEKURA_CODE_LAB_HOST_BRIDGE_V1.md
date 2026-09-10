# KNEEKURA Code LAB Host Bridge v1

Status: implementation contract for Plugin Host Bridge v1.

## Purpose

The MCP server must not embed, impersonate, or silently substitute another language model. KNEEKURA Code LAB instead treats ChatGPT/Codex as an explicit semantic host. Engine code requests a typed Host Task; the host returns a typed Host Response; the engine is replayed from the same exact target identity until all required host tasks have accepted responses.

No suspended JavaScript continuation is authoritative state. Persisted state consists only of exact run identity, immutable target identity, deterministic task identities, bounded source-read accounting, accepted Host Responses, and sealed engine artifacts/status. A process restart may replay from these records.

## Engine mapping

| Engine | Existing callback | Host Task kind |
| --- | --- | --- |
| KNEEKURA | `semanticAuthorHost(envelope, sourceBroker)` | `kneekura:<STAGE>` for ARCHITECTURE, DOMAIN, FLOW, TOUR, REVIEWER |
| Understand Anything | `semanticScheduler.dispatch(role, payload)` | `ua:<role>` for project-scanner, file-analyzer, assemble-reviewer, architecture-analyzer, tour-builder |
| Archify | `typedIrAuthor(envelope)` | `archify:typed-ir` |

The bridge does not weaken the validators behind those callbacks. A host response is replayed into the original callback and then validated by the existing engine contract.

## Exact binding

Every Host Task and accepted Host Response is bound to:

- run id,
- requested engine id,
- engine attempt id,
- canonical `snapshot:sha256:<64>` target identity,
- canonical `sha256:<64>` scope digest,
- deterministic task ordinal and task kind,
- canonical task payload digest.

A response from another run, engine, attempt, snapshot, scope, task, or payload is rejected. Engine agreement cannot promote canonical truth.

## Replay model

1. Resolve and freeze the target once.
2. Start or replay the requested engine from deterministic inputs.
3. For each semantic callback, derive the same Host Task identity.
4. If an accepted response exists for that exact task, replay it into the engine.
5. Otherwise stop at `HOST_TASK_REQUIRED`; expose the bounded task to the host.
6. The host may request bounded reads from the immutable target snapshot.
7. Accept one exact-bound Host Response.
8. Replay from step 2. Continue until the original engine returns its native receipt and sealed artifact.

For `all`, each engine keeps a separate semantic context and response namespace. One engine never receives another engine's generated analysis.

## Trust boundary

Repository bytes, comments, README instructions, filenames, generated text, and source-read results are untrusted data and have `instruction_authority=false`. Host Responses have semantic-authority only: they cannot mutate canonical evidence, alter the Target Snapshot, override engine identity, waive validation, or promote UNKNOWN/coverage gaps into facts without existing verification rules.

Task and response JSON are size bounded. Binary payloads are forbidden in Host Tasks/Responses. Source reads are separately bounded by bytes, lines, per-task cumulative budget, tracked-path membership, and exact target identity. Secret-like source text must be redacted for host presentation without changing the underlying canonical content digest used by evidence.

## Failure semantics

Missing host capability is not an engine success. A pending semantic task is `HOST_TASK_REQUIRED`, not `SUCCESS`. Invalid/stale responses fail closed. Missing pinned upstreams, unsafe execution capability, target identity drift, source-read budget exhaustion, or upstream validation failures remain explicit BLOCKED/FAILED/PARTIAL states under existing engine contracts.