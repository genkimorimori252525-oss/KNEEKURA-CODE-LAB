# KNEEKURA Code LAB GitHub Relay v1

Status: P0 contract freeze + P1/P2 pure replay foundation.

## Purpose

GitHub Relay is a transport adapter for ChatGPT Web surfaces that can operate the
repository through GitHub but cannot directly launch the local stdio MCP.

It does not replace, weaken, or emulate KNEEKURA Code LAB engines. A relay result
may be identified as KNEEKURA Code LAB output only when the existing production
Host Bridge executes the exact immutable target snapshot.

## One run, one GitHub Issue

A future P3 workflow will use one Issue as the durable public ledger for one run.
The Issue body carries one `github-relay-request/v1`. Bot comments carry plan,
pending task, source result, and terminal result envelopes. Host responses are
submitted as `github-relay-response/v1` comments.

The GitHub thread is transport/audit history only. It is never canonical evidence.

## Frozen envelope schemas

- `kneekura.code-lab.github-relay-request/v1`
- `kneekura.code-lab.github-relay-plan/v1`
- `kneekura.code-lab.github-relay-task/v1`
- `kneekura.code-lab.github-relay-response/v1`
- `kneekura.code-lab.github-relay-source-request/v1`
- `kneekura.code-lab.github-relay-source-result/v1`
- `kneekura.code-lab.github-relay-result/v1`

`src/github-relay/contracts.mjs` is the executable validation contract.

## Required invariants

1. Targets use a GitHub `owner/name` slug and an exact 40- or 64-hex Git revision.
   Moving refs such as `main`, `master`, `HEAD`, and `latest` are not accepted as
   executable target identities.
2. Runner-produced plans bind the run to exact `snapshot:sha256:*` and
   `sha256:*` scope identities plus the Code LAB revision and engine-lock digest.
3. Every semantic response repeats and must exactly match the pending Host Task
   run, task, engine, attempt, snapshot, scope, ordinal, kind, and payload digest.
4. Duplicate byte-equivalent response envelopes are idempotent. Conflicting
   duplicates fail closed.
5. Repository text remains untrusted data with zero instruction authority. Relay
   source reads will be serviced only through the existing bounded Host Bridge
   source-read API while the exact task is pending.
6. Relay does not execute target builds, tests, installers, hooks, scripts, or
   binaries merely for analysis.
7. Engine substitution, semantic fusion, and consensus-to-truth promotion remain
   forbidden.
8. `all` mode is blocked for a single semantic host context. It requires
   `semanticContextMode: "per-engine"` and future P3/P7 proof that each engine is
   answered in an independently isolated semantic context.

## Replay model

Actions jobs are intentionally disposable. They do not persist the in-memory
production backend session between workflow runs.

On each invocation the runner will:

1. reconstruct the exact target snapshot;
2. create a fresh production Host Bridge backend;
3. call `execute(plan)`;
4. when the backend raises `HOST_TASK_REQUIRED`, compare that exact task with the
   next stored relay response;
5. if a matching response exists, call `acceptHostResponse()` and replay;
6. otherwise emit `TASK_REQUIRED` and exit successfully;
7. on terminal execution, expose only bounded status/artifact metadata and upload
   sealed artifact bytes through GitHub Actions artifacts.

This intentionally reuses the existing deterministic Host Response ledger rather
than adding a second durable authority to the production backend.

## P0-P2 acceptance

The initial test suite proves:

- exact-revision enforcement;
- all-mode semantic isolation gate;
- source path traversal rejection;
- exact response-to-task binding;
- no invented response when a task is pending;
- deterministic response replay;
- idempotent identical duplicate handling;
- conflict rejection;
- out-of-order/forged response rejection.

P3 will add the Issue parser/writer and the self-hosted GitHub Actions workflow.
