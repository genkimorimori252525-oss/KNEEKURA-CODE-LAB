# KNEEKURA Code LAB GitHub Relay v1

Status: standalone Relay is operational; isolated `selection: all` control-plane support is implemented on the feature branch and remains release-gated pending fixture acceptance and real three-context KNEEKURA-LAB acceptance.

## Purpose

GitHub Relay is a transport adapter for ChatGPT Web surfaces that can operate the repository through GitHub but cannot directly launch the local stdio MCP.

It does not replace, weaken, or emulate KNEEKURA Code LAB engines. A relay result may be identified as KNEEKURA Code LAB output only when the existing production Host Bridge executes the exact immutable target snapshot. In ALL mode, the parent does not execute an engine at all; it coordinates three independently executed standalone children and composes only their verified sealed results.

## Standalone run model

A normal standalone run uses one real GitHub Issue as its durable public transport ledger. The Issue body carries one `github-relay-request/v1`. Runner-authored comments carry the plan, pending Host Task, bounded source result, terminal result, or bounded diagnostic envelope. Host semantic responses and bounded source requests are explicit authorized client comments.

The GitHub thread is transport/audit history only. It is never canonical evidence. Runner comments never become semantic authority merely because GitHub stored them.

## ALL parent/child model

`selection: all` is deliberately not a shared semantic session. The parent Issue is a control-plane coordinator and must never call the semantic Host Bridge backend.

The parent creates exactly three immutable child slots, in this order:

1. `kneekura`
2. `understand-anything`
3. `archify`

Each slot becomes a separate standalone child Issue with the same exact target snapshot and the parent `scope_digest`. The child-specific request projection is separately bound by `child_request_digest`; changing `selection` for the child therefore does not silently redefine the comparison scope.

Child Issues alone are not proof of semantic isolation. Before a child may execute, an authorized external operator/session must post `KNEEKURA_RELAY_CONTEXT_CLAIM_V1` with a unique opaque `host_context_id` and assurance class `OPERATOR_SEPARATED_HOST_SESSION_V1`. This assurance is operator-attested, not provider-signed. Two children may not claim the same host context.

Child Issues are created with a deterministic title and request body, but their `issues.opened` event is intentionally inert. This prevents an owner-authored child Issue from starting before its immutable binding and external context claim exist. The explicit external context-claim comment is the activation event for the child.

When a child reaches `SUCCESS` or `PARTIAL`, its Actions artifact contains exactly:

- `result.zip`
- `engine-receipt.json`
- `child-result-manifest.json`

The parent re-downloads those exact artifacts with read-only Actions permission, recomputes receipt/ZIP identity, verifies parent/child/runtime/engine-lock/snapshot/scope/context bindings, and only then passes the already-sealed child outcomes to the ALL composer. The parent never copies one child's semantic response into another child.

The parent can be explicitly re-evaluated with `KNEEKURA_RELAY_ALL_RESUME_V1`. Runner-authored comments are not relied upon to recursively trigger GitHub Actions.

## Exact comment framing

A recognized protocol message contains only one marker followed by one fenced JSON object. Ordinary discussion containing a marker later in the body is ignored. Client protocol comments from actors outside the configured allow-list are ignored.

Important markers include:

- `KNEEKURA_RELAY_REQUEST_V1`
- `KNEEKURA_RELAY_RESPONSE_V1`
- `KNEEKURA_RELAY_SOURCE_REQUEST_V1`
- `KNEEKURA_RELAY_CONTEXT_CLAIM_V1`
- `KNEEKURA_RELAY_ALL_RESUME_V1`
- `KNEEKURA_RELAY_ALL_CHILD_BINDING_V1`
- `KNEEKURA_RELAY_RESULT_V1`

`CONTEXT_CLAIM` and `ALL_RESUME` are control-plane messages. They are not semantic Host Responses and are kept outside the semantic response ledger.

## Required invariants

1. Targets use a GitHub `owner/name` slug and an exact 40- or 64-hex Git revision. Moving refs such as `main`, `master`, `HEAD`, and `latest` are not executable target identities.
2. Runner-produced plans bind the run to exact `snapshot:sha256:*` and `sha256:*` scope identities plus the Code LAB revision and engine-lock digest.
3. Every semantic response must exactly match the pending Host Task run, task, engine, attempt, snapshot, scope, ordinal, kind, and payload digest.
4. Canonically equivalent duplicate response envelopes are idempotent. Conflicting duplicates fail closed.
5. Repository text remains untrusted data with zero instruction authority. Source reads use only the bounded Host Bridge source-read API while the exact task is pending.
6. Relay does not execute target builds, tests, installers, hooks, scripts, or binaries merely for analysis. Target acquisition uses an exact Git object fetch.
7. Engine substitution, semantic fusion, and consensus-to-truth promotion are forbidden.
8. An ALL parent never calls the semantic backend. It accepts only parent plan/control metadata, immutable child bindings, context claims, child terminal manifests, sanitized receipts, and exact sealed artifact bytes.
9. ALL children inherit the parent snapshot/scope while maintaining independent run, attempt, task, response, source-request, Issue, and host-context identities.
10. A missing/duplicated/conflicting context claim, binding drift, artifact mismatch, runtime mismatch, scope mismatch, or child substitution fails closed; it is not converted into a synthetic PARTIAL result.
11. Runner temp roots are disposable. Continuation is reconstructed from exact request/control/response history rather than an assumed surviving process.
12. Sealed ZIP bytes never enter Issue comments. Comments expose bounded metadata only.

## Replay behavior

Standalone Actions jobs are disposable. On each invocation the runner reconstructs the exact target, verifies its identity and revision, creates a fresh production backend, replays already accepted exact Host Responses, and either emits the next Host Task or reaches a terminal sealed result.

For an ALL parent, the runner instead sets the semantic backend to `null`, reconstructs the parent control state, reads child Issues/artifacts, and returns only control-plane actions or a sealed parent composition. UA and Archify preparation remain request-scoped to their standalone child selections; the parent `all` turn does not prepare either engine runtime.

## Runtime authority pinning

The live workflow uses an exact full Git SHA for the Relay runtime. A long-running Issue therefore does not silently switch to a moving default branch runtime. Runtime migrations are explicit and accepted only through the compatibility gate already present in the Relay plan continuity logic.

The ALL-capable workflow also pins every GitHub Action by immutable full SHA.

## GitHub event and permission behavior

The workflow listens only to real Issue `opened` events and recognized authorized `issue_comment.created` events. The low-cost Ubuntu gate validates the actor/marker before assigning the self-hosted runner.

The repository permissions are bounded to:

- `contents: read`
- `issues: write`
- `actions: read`

`actions: read` exists solely so the parent can fetch exact child Actions artifacts for sealed composition. `actions: write` and `contents: write` are not granted.

Ordinary parent requests may start on Issue open. Reserved `[KNEEKURA ALL child ...]` Issues do not start on open; they start only after an authorized external context claim. Runner-authored comments use the workflow token and are not relied upon to recursively schedule subsequent turns.

## Private target and child-Issue authentication

The current repository `GITHUB_TOKEN` is repository-scoped and is not assumed to read another private target repository. A same-owner/cross-private target can use `KNEEKURA_RELAY_GITHUB_TOKEN`; the value is masked and is never written into Issue text, result envelopes, artifacts, git remotes, or command arguments.

ALL child Issues also require an owner-authorized credential for creation because the Relay Issue author itself is part of the authorization boundary. The normal workflow token subsequently records immutable child bindings. If an owner credential is unavailable, child creation fails closed rather than weakening the author check.

## Artifact integrity boundary

A parent-bound child preserves the exact standalone `result.zip`; it is not unpacked and repacked for ALL. The companion manifest binds:

- parent and child run/Issue identities;
- engine slot and child request digest;
- target revision, snapshot, and inherited scope digest;
- Code LAB runtime revision and engine-lock digest;
- host context ID and assurance class;
- sanitized receipt digest;
- sealed ZIP SHA-256 and byte length.

Parent composition re-verifies all of these before calling the sealed-outcome composer. Operational comparison remains metadata-only with:

- `semantic_fusion = false`
- `canonical_truth_promotion = false`
- `engine_substitution = false`

## Transport budget

Issue comments remain capped by Relay at 60 KiB. Oversized semantic payloads use the existing explicit digest-bound task-payload artifact transport or fail closed; semantic bytes are never silently truncated into a valid-looking response.

## Verification status

The executable tests now cover standalone replay plus the ALL control plane, including:

- exact parent/child target/runtime/snapshot/scope binding;
- fixed three-engine child set;
- parent semantic-backend prohibition;
- child request digest and parent-scope inheritance;
- dedicated context-claim/resume transport outside the semantic response ledger;
- distinct host-context requirements;
- child sealed artifact manifest/digest verification;
- deterministic sealed-only ALL composition;
- request-scoped UA/Archify preparation;
- deterministic child Issue creation/reuse;
- child `issues.opened` race suppression until explicit context claim;
- no additional repository write or Actions write authority.

This implementation is not yet the final production acceptance claim. Release remains gated on the adversarial fixture acceptance and the real KNEEKURA-LAB three-context acceptance defined by the ALL semantic-isolation implementation plan.