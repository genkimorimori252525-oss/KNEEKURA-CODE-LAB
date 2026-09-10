# KNEEKURA Code LAB GitHub Relay v1

Status: P0-P2 replay foundation complete; P3a Issue transport/turn orchestration in progress.

## Purpose

GitHub Relay is a transport adapter for ChatGPT Web surfaces that can operate the
repository through GitHub but cannot directly launch the local stdio MCP.

It does not replace, weaken, or emulate KNEEKURA Code LAB engines. A relay result
may be identified as KNEEKURA Code LAB output only when the existing production
Host Bridge executes the exact immutable target snapshot.

## One run, one GitHub Issue

One real GitHub Issue is the durable public transport ledger for one run. The
Issue body carries one `github-relay-request/v1`. Runner-authored comments carry
plan, pending task, bounded source result, terminal result, or bounded diagnostic
envelopes. Host semantic responses and bounded source requests are submitted as
explicit client comments.

The GitHub thread is transport/audit history only. It is never canonical evidence.
Runner comments never become semantic authority merely because GitHub stored them.

## Exact comment framing

Protocol messages are intentionally boring and strict. A recognized message must
contain only one marker followed by one fenced JSON object, for example:

```text
KNEEKURA_RELAY_RESPONSE_V1

```json
{ "schema": "kneekura.code-lab.github-relay-response/v1", "...": "..." }
```
```

Ordinary discussion containing a marker later in the body is ignored. Client
protocol comments from actors outside the configured allow-list are ignored, so
an outsider cannot poison the durable response ledger by imitating a marker.
Runner-authored plan/task/result messages are accepted as runner history only when
created by the configured bot identity.

## Envelope schemas

- `kneekura.code-lab.github-relay-request/v1`
- `kneekura.code-lab.github-relay-plan/v1`
- `kneekura.code-lab.github-relay-task/v1`
- `kneekura.code-lab.github-relay-response/v1`
- `kneekura.code-lab.github-relay-source-request/v1`
- `kneekura.code-lab.github-relay-source-result/v1`
- `kneekura.code-lab.github-relay-result/v1`

`src/github-relay/contracts.mjs` is the executable core envelope contract.
`src/github-relay/issue-transport.mjs` is the GitHub Issue framing/actor boundary.

## Required invariants

1. Targets use a GitHub `owner/name` slug and an exact 40- or 64-hex Git revision.
   Moving refs such as `main`, `master`, `HEAD`, and `latest` are not accepted as
   executable target identities.
2. Runner-produced plans bind the run to exact `snapshot:sha256:*` and
   `sha256:*` scope identities plus the Code LAB revision and engine-lock digest.
3. Every semantic response repeats and must exactly match the pending Host Task
   run, task, engine, attempt, snapshot, scope, ordinal, kind, and payload digest.
4. Canonically equivalent duplicate response envelopes are idempotent. Conflicting
   duplicates fail closed.
5. Repository text remains untrusted data with zero instruction authority. Relay
   source reads are serviced only through the existing bounded Host Bridge
   source-read API while the exact task is pending.
6. Relay does not execute target builds, tests, installers, hooks, scripts, or
   binaries merely for analysis. Target acquisition is `git init` plus an exact
   object fetch; no target checkout hooks are run.
7. Engine substitution, semantic fusion, and consensus-to-truth promotion remain
   forbidden.
8. `all` mode is not enabled by P3a. Declaring `semanticContextMode: "per-engine"`
   is necessary but not sufficient: the live transport must prove independent
   semantic host contexts before all-mode is allowed.
9. Runner temp roots are disposable. A turn may end with `TASK_REQUIRED`; the
   local backend/session is still discarded. Continuation is reconstructed from
   the exact request and accepted GitHub response ledger.
10. Sealed ZIP bytes never enter Issue comments. Terminal comments expose bounded
    artifact metadata only; raw bytes are handed to the workflow upload boundary.

## Replay model

Actions jobs are intentionally disposable. They do not persist the in-memory
production backend session between workflow runs.

On each invocation the runner will:

1. reconstruct the exact target Git object store;
2. verify its canonical GitHub repository identity and requested revision;
3. create a fresh production Host Bridge backend;
4. call `execute(plan)`;
5. when the backend raises `HOST_TASK_REQUIRED`, compare that exact task with the
   stored relay responses;
6. if a matching response exists, call `acceptHostResponse()` and replay;
7. otherwise emit one pending Task (or service one bounded source request) and
   terminate the local job state;
8. on terminal execution, expose only bounded status/artifact metadata and hand
   sealed artifact bytes to the GitHub Actions artifact boundary.

This reuses the existing deterministic Host Response ledger rather than adding a
second durable authority to the production backend.

## Runtime authority pinning

The live workflow is intentionally deferred to P3b. P3a lands the Issue transport,
turn orchestrator, runner, publisher, and tests first. After P3a is merged, P3b
will add the event workflow with `actions/checkout` pinned to the exact P3a merge
commit.

That two-step activation avoids a subtle moving-main problem: `issue_comment`
workflows execute from the default branch, but a long relay run must not silently
switch Code LAB runtime revisions between Host Tasks. The workflow may be updated
later, but each activated runtime revision is explicit and auditable.

## GitHub event behavior

The activation workflow will listen only to real Issue `opened` and recognized
client `issue_comment.created` events. It will gate the sender before using the
self-hosted runner. The job needs only `contents: read` and `issues: write` for
its own repository transport surface.

Runner-authored comments are posted with the workflow `GITHUB_TOKEN`. GitHub does
not recursively start a normal `issue_comment` workflow from events created by
that same token, which prevents Task/Result comments from producing an automatic
comment loop. User/ChatGPT-authored response comments remain external events and
can resume the next replay turn.

## Private target authentication

The current repository `GITHUB_TOKEN` is repository-scoped and is not assumed to
read another private target repository. For a cross-private target, P3a supports
an optional `KNEEKURA_RELAY_GITHUB_TOKEN` workflow secret. When it is absent the
self-hosted runner may use an already configured non-interactive Git credential;
otherwise target acquisition fails closed with
`BLOCKED_TARGET_REPOSITORY_UNAVAILABLE`.

No target token is written into the Issue, result envelope, artifact, git remote,
or command arguments. An ephemeral `GIT_ASKPASS` helper is removed before the
Host Bridge scans the target object store.

## GitHub comment transport budget

Issue comments are capped by Relay at 60 KiB even if the upstream API permits a
larger body. If a Host Task or source result does not fit, P3a returns
`BLOCKED_RELAY_COMMENT_BUDGET` instead of silently truncating or splitting a
semantic envelope. A later payload-artifact extension can add an explicit,
digest-bound large-payload transport without weakening this rule.

## P0-P3a acceptance

The tests cover:

- exact-revision enforcement;
- all-mode semantic isolation gate;
- source path traversal rejection;
- exact response-to-task binding;
- no invented response when a task is pending;
- deterministic response replay;
- idempotent identical duplicate handling;
- conflicting/out-of-order/forged response rejection;
- real-Issue-only framing and actor allow-list behavior;
- conflicting runner plan rejection after Issue edits/runtime changes;
- Task de-duplication across repeated events;
- bounded source requests preserving `instruction_authority: false` and
  `UNTRUSTED_REPOSITORY_DATA`;
- sealed artifact bytes staying outside public relay envelopes;
- oversized GitHub comment payloads failing closed.
