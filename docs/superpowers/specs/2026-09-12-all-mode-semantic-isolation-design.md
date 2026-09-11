# KNEEKURA Code LAB ALL Mode Semantic-Context Isolation Design

Status: **DESIGN FROZEN FOR IMPLEMENTATION PLANNING**  
Date: 2026-09-12 JST  
Authority repository: `genkimorimori252525-oss/KNEEKURA-CODE-LAB`  
Inspected base: `d6c02ac67f653dfe2fd942e6a899a00c16a7facf`

## 1. Decision

GitHub Relay `selection: "all"` will use a **control-only parent plus three independently claimed standalone child contexts**. The parent never executes a semantic engine.

```text
ALL parent issue
  |
  +-- KNEEKURA child issue  -- isolated host context --> sealed KNEEKURA result
  +-- UA child issue        -- isolated host context --> sealed UA result
  `-- Archify child issue   -- isolated host context --> sealed Archify result
                                      |
                                      v
                         parent sealed-only composition
```

The parent sees only immutable bindings, context-claim metadata, sanitized receipts, and already-sealed artifact bytes. It never consumes semantic Host responses and never forwards one engine's output into another engine.

## 2. Existing state and the two gaps

The current core ALL implementation already gives each engine a distinct attempt/context ID, sets `freshSemanticContextRequired: true`, binds Host Tasks to engine/attempt/snapshot/scope, seals engine results, and keeps `semantic_fusion=false` and consensus-to-truth promotion disabled.

That is not enough for ChatGPT Web Relay because one Issue can still be processed inside one model conversation. Separate identifiers do not erase shared semantic memory. The existing Relay design therefore correctly says that `semanticContextMode: "per-engine"` is necessary but not sufficient.

There are also two concrete implementation gaps:

1. `runGithubRelayTurn()` currently sends `selection: all` through `replayGithubRelayRun()` and the production backend. ALL must instead be intercepted before semantic backend execution and routed to the parent controller path.
2. `relayScopeDigest()` includes `selection` and `semanticContextMode`. If each child recomputed a normal standalone scope digest, the three children would not share the parent's ALL scope. Child execution must therefore inherit the exact **parent scope digest** while separately binding the child request projection with a child-request digest.

These two gaps are hard requirements of this design, not optional refinements.

## 3. Required invariants

The implementation must guarantee:

- one exact target repository and revision;
- one exact canonical snapshot ID shared by parent and all children;
- one exact parent scope digest shared by all engine receipts;
- exactly three child slots: `kneekura`, `understand-anything`, `archify`;
- one distinct host semantic context identity per child;
- no cross-child Host response replay;
- no cross-child source-request replay;
- no engine substitution;
- no semantic fusion;
- no consensus-to-canonical-truth promotion;
- parent comparison only after child sealing;
- deterministic parent bundle for identical verified child bytes and metadata;
- unchanged standalone behavior outside parent-bound child mode.

## 4. Non-goals

This design does not merge semantic claims, select a winning engine, create majority-vote truth, expose sealed bytes in Issue comments, change upstream engine pins, or claim cryptographic knowledge of hidden model memory when a host does not expose authenticated session identity.

## 5. Semantic-context assurance

### 5.1 Context claim

Before a child may emit or accept semantic Host Tasks, an allowed external host session must claim it with:

```text
parent_run_id
child_issue_number
engine_id
host_context_id
assurance_class
```

`host_context_id` is opaque and stable for that child. Code LAB does not invent it on behalf of the semantic host.

For current ChatGPT Web acceptance the assurance class is:

`OPERATOR_SEPARATED_HOST_SESSION_V1`

This means the three child Issues are deliberately handled in three separate ChatGPT conversations and the acceptance evidence records three distinct context IDs. This is an operational separation proof, not a signed provider attestation.

### 5.2 Fail closed

ALL remains blocked with `BLOCKED_SEMANTIC_CONTEXT_ISOLATION` if:

- any child has no accepted context claim;
- two children use the same context ID;
- a claim names the wrong parent/child/engine;
- a child changes context ID after semantic replay begins;
- the requested assurance class cannot be provided.

A child may perform an early sibling-collision check, but the **authoritative collision check is repeated by the parent immediately before composition** so concurrent claims cannot bypass isolation by race.

Distinct Issue numbers alone are not context proof.

## 6. Parent identity and scope authority

The parent ALL request remains the sole authority for semantic scope. Its immutable plan records:

```text
parent_run_id
selection = all
semantic_context_mode = per-engine
target.repository
target.revision
target.snapshot_id
target.scope_digest          # authoritative scope used by all child engine receipts
code_lab_revision
engine_lock_digest
children[3]
```

The parent scope digest is computed once from the ALL request exactly as authorized. Children do **not** recompute their engine receipt scope from a single-engine Relay request.

Each child descriptor additionally records a deterministic `child_request_digest`. That digest binds the exact projection of the parent request allowed for that engine, including the engine slot, common scope, engine-specific options, minimum claim requirement, parent run ID, and parent scope digest.

This separates two identities that must not be conflated:

- `target.scope_digest`: shared semantic scope authority for all three engines;
- `child_request_digest`: proof that a child Issue is the exact engine-specific projection authorized by the parent.

## 7. Child identity

A child is a parent-bound standalone execution. Its immutable request binding contains:

```text
parent_run_id
parent_issue_number
parent_scope_digest
engine_id
child_slot
child_request_digest
```

The child independently resolves the exact target repository/revision and recomputes the canonical snapshot. It must equal the parent's snapshot. The child execution plan then uses the parent's bound scope digest for the engine receipt.

A parent-bound child may not silently fall back to ordinary standalone scope derivation. A normal standalone request that has no parent binding keeps the current behavior unchanged.

## 8. Parent creation lifecycle

On an allowed `selection: all`, `semanticContextMode: per-engine` parent Issue:

1. validate the parent request;
2. resolve canonical repository identity and exact snapshot;
3. compute the authoritative parent scope digest;
4. emit the immutable parent plan;
5. create or recover exactly three immutable child Issue bindings;
6. write one child Issue per engine with the authorized child projection;
7. publish `ALL_CONTEXTS_REQUIRED` with the three child Issue references;
8. stop without calling `replayGithubRelayRun()` or `backend.execute()`.

Repeated parent turns recover existing child slots. They never create replacement children for a slot that is already bound.

Child Issues created by the workflow token are intentionally not expected to recursively start Actions. A child begins only when an allowed external semantic host posts a context claim.

## 9. Child lifecycle

On `KNEEKURA_RELAY_CONTEXT_CLAIM_V1`:

1. validate parent/child binding and child request digest;
2. verify the target snapshot equals the parent snapshot;
3. bind the context claim;
4. enter the existing standalone engine replay loop;
5. prepare only that engine through its already-proven path;
6. accept only task responses matching the child run/engine/attempt/snapshot/parent-scope/task binding;
7. produce a terminal child result and sealed artifact package.

Engine preparation remains standalone:

- KNEEKURA: existing first-party path;
- UA: pinned v2.9.0 preparation plus verified dashboard boundary;
- Archify: pinned v2.16.0 preparation.

There is no combined ALL engine-preparation path.

## 10. Replay isolation

Relay state is split by construction:

```text
parent ledger: control messages only
KNEEKURA child ledger: KNEEKURA semantic responses only
UA child ledger: UA semantic responses only
Archify child ledger: Archify semantic responses only
```

No combined semantic response ledger exists at parent level.

A response copied from one child to another must fail exact binding even when its response body is otherwise valid. Cross-child source requests must fail for the same reason.

The parent collector has no API for semantic Host Task replay or source reads.

## 11. Child sealed-result transport

Each successful or partial child Actions artifact contains:

```text
result.zip
engine-receipt.json
child-result-manifest.json
```

`result.zip` is the exact existing sealed engine delivery artifact. Its digest and bytes remain unchanged.

`engine-receipt.json` is a sanitized engine receipt.

`child-result-manifest.json` binds:

- parent run/Issue;
- child run/Issue;
- engine slot;
- host context ID and assurance class;
- target repository/revision/snapshot;
- parent scope digest;
- child request digest;
- Code LAB runtime revision;
- engine-lock digest;
- receipt digest;
- result ZIP digest and byte count.

Issue comments expose only bounded metadata and artifact locators, never sealed bytes.

## 12. Parent composition lifecycle

Parent composition is triggered by an allowed external parent resume/compose message after children are terminal. Workflow-token child result comments do not recursively drive the parent.

The parent collector is allowlisted to read only:

- parent/child binding records;
- context-claim records;
- terminal child result envelopes;
- child artifact locators and bounded manifests.

It must not parse child semantic TASK, RESPONSE, or SOURCE_RESULT bodies.

Before composition the parent:

1. requires all three child slots to be terminal;
2. rechecks three distinct context IDs;
3. downloads each exact child Actions artifact;
4. verifies result ZIP digest/bytes;
5. verifies receipt and child manifest digests;
6. verifies engine identity and slot;
7. verifies repository/revision/snapshot;
8. verifies **parent scope digest** equality across all receipts;
9. verifies child request digest against the parent's authorized projection;
10. verifies Code LAB runtime and engine-lock identity;
11. passes only verified receipt metadata and sealed bytes to the composer.

Integrity mismatch is a composition failure, not a semantic PARTIAL result.

## 13. Sealed-outcome composer

The current core ALL logic should be factored into:

1. engine execution -> sealed outcome;
2. verified sealed outcomes -> deterministic ALL bundle.

The second stage is reusable by local ALL mode and Relay parent composition. It has no semantic scheduler, repository reader, source broker, or Host Task interface.

It receives exactly three verified outcomes and preserves:

```text
semantic_fusion = false
canonical_truth_promotion = false
engine_substitution = false
comparison_policy = sealed-operational-metadata-only
```

The final bundle includes the exact child `result.zip` bytes, sanitized receipts/outcomes, parent manifest, and operational comparison metadata. It does not contain child semantic response text.

## 14. Status semantics

A parent is non-terminal while a child is absent, unclaimed, or still pending semantic tasks.

After all three children are terminal:

- three `SUCCESS` + satisfied claims -> parent `SUCCESS`;
- at least one `SUCCESS`/`PARTIAL` plus at least one non-success or unsatisfied result -> parent `PARTIAL`;
- no `SUCCESS`/`PARTIAL` child -> parent `FAILED`.

A missing context claim is `CONTEXTS_REQUIRED`, not an engine failure.

A failed engine remains failed in its fixed slot. No sibling can substitute for it.

Target drift, scope drift, runtime drift, context collision, receipt/artifact corruption, or substitution invalidates composition and fails closed rather than becoming PARTIAL.

## 15. Workflow permissions and preparation

The parent turn needs Issue write/read capability to create/recover child Issues and Actions read capability to retrieve child artifacts during composition. It does not need UA or Archify executable roots.

The child turn keeps the existing standalone permissions and engine-specific preparation.

Workflow tests must prove that a parent `selection: all` does not execute engine prep and that child UA/Archify still do.

## 16. Compatibility

Standalone Relay requests remain unchanged.

Parent-bound child mode is explicit and cannot be inferred from ordinary standalone requests. Existing standalone `relayScopeDigest()` behavior therefore remains compatible; only a validated parent-bound child execution receives a parent scope override.

Local/in-process ALL mode does not use GitHub child Issues. It may reuse the sealed-outcome composer to avoid duplicate comparison/package logic.

Until real three-context acceptance passes, Relay ALL remains fail-closed or non-terminal and must not fall back to same-context sequential execution.

## 17. TDD and adversarial test matrix

### Contracts

- ALL requires `per-engine`;
- exactly three fixed engine slots;
- immutable parent/child binding;
- exact child request digest;
- parent scope inheritance;
- duplicate identical context claim idempotence;
- conflicting re-claim rejection;
- sibling context-ID collision rejection.

### Orchestration

- `selection: all` is intercepted before `replayGithubRelayRun()`/backend execution;
- parent creates exactly three idempotent child slots;
- parent never emits a semantic Host Task;
- ordinary standalone orchestration remains unchanged.

### Isolation

- KNEEKURA response -> UA: rejected;
- UA response -> Archify: rejected;
- Archify response -> KNEEKURA: rejected;
- source request crossing child boundary: rejected;
- same context ID on concurrent children: parent composition rejects even if child admission raced;
- parent collector ignores semantic task/response bodies.

### Scope and identity

- child recomputing selection-specific scope is rejected;
- all child receipts carry the exact parent scope digest;
- snapshot mismatch rejected;
- runtime mismatch rejected;
- engine-lock mismatch rejected;
- child request projection mismatch rejected.

### Composer

- exactly one outcome per engine;
- sealed ZIP receipt binding verified;
- no substitution;
- no semantic fusion;
- no consensus truth promotion;
- deterministic output for identical verified bytes/metadata;
- frozen status semantics preserved.

### Workflow

- parent requires no UA/Archify prep;
- UA child uses pinned UA prep;
- Archify child uses pinned Archify prep;
- parent can read child Actions artifacts;
- workflow-created child Issues do not depend on recursive event triggering;
- external context claim activates a child.

## 18. Real acceptance

Target:

`genkimorimori252525-oss/KNEEKURA-LAB@e96e40ab0fc7a8995a1972d8f9defb2aa894ad0e`

Acceptance requires:

1. one ALL parent Issue;
2. exactly three bound child Issues;
3. three separate host semantic sessions and three distinct context IDs;
4. one shared canonical snapshot ID;
5. one shared parent scope digest in all engine receipts;
6. three independently completed standalone child engine paths;
7. three sealed child results with verified receipts/manifests;
8. no cross-child semantic response/source replay;
9. one deterministic parent ALL bundle built only after sealing;
10. parent comparison records `semantic_fusion=false`, `canonical_truth_promotion=false`, `engine_substitution=false`;
11. deliberate cross-child replay attack is rejected;
12. standalone KNEEKURA, UA, and Archify regression checks remain green.

The acceptance record must label `OPERATOR_SEPARATED_HOST_SESSION_V1` as operational evidence rather than cryptographic provider attestation.

## 19. Adversarial review findings

| Failure mode | Defense |
| --- | --- |
| Three Issues handled in one semantic conversation | Distinct host context claims are required; Issue identity alone is insufficient. |
| Same context claims two children concurrently | Parent performs authoritative uniqueness recheck immediately before composition. |
| Parent accidentally executes semantic engine | ALL is intercepted before replay/backend execution. |
| Child computes standalone selection-specific scope | Parent-bound child must inherit parent scope; child request has a separate digest. |
| Child request drifts from parent options/question | Parent-authorized child request digest must match. |
| KNEEKURA answer copied into UA | Exact child run/engine/attempt/task binding rejects it. |
| Engine output influences later engine prompt | Sibling results are unavailable to semantic child execution; parent sees them only after sealing. |
| Majority vote becomes truth | Composer is metadata-only and truth promotion remains false. |
| Failed engine replaced by sibling | Fixed engine slots and substitution prohibition. |
| Child analyzes another commit | Parent rejects repository/revision/snapshot mismatch. |
| Child runs another runtime/lock | Parent rejects runtime/engine-lock mismatch. |
| Artifact changes after terminal result | Parent recomputes digest and byte count. |
| Workflow-created child never auto-starts | Intentional; external context claim is required. |
| Repeated parent turn creates extra child | Immutable idempotent child-slot registry. |
| Missing child is misreported FAILED | Parent remains non-terminal/CONTEXTS_REQUIRED. |
| Parent reads semantic child comments | Collector input allowlist excludes TASK/RESPONSE/SOURCE_RESULT bodies. |

The self-review found and resolved the parent-vs-child scope-digest defect before implementation. No Critical/High design issue is left unresolved in this specification. The explicit residual limitation is that current ChatGPT Web context separation is operator-attested, not cryptographically provider-attested.

## 20. Implementation boundary

Implementation order is fixed:

1. contract tests for parent binding, child request digest, context claim, and parent scope inheritance;
2. sealed-outcome composer extraction with RED/GREEN tests;
3. parent-controller orchestration tests and implementation;
4. child parent-bound scope path and replay-isolation tests;
5. child receipt/manifest artifact transport;
6. workflow permission/preparation changes;
7. fixture-level parent/three-child acceptance;
8. adversarial regression;
9. real three-context KNEEKURA-LAB acceptance;
10. only after acceptance, treat GitHub Relay ALL as enabled behavior.

No implementation stage may downgrade to shared-context sequential execution.