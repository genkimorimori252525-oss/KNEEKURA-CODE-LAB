# KNEEKURA Code LAB ALL Mode Semantic-Context Isolation Design

Status: **DESIGN FROZEN FOR IMPLEMENTATION PLANNING**  
Date: 2026-09-12 JST  
Authority repository: `genkimorimori252525-oss/KNEEKURA-CODE-LAB`  
Base revision inspected: `d6c02ac67f653dfe2fd942e6a899a00c16a7facf`

## 1. Decision

GitHub Relay `selection: "all"` will not run the three semantic engines inside one Relay issue or one host semantic session. It will use a **parent controller plus three independently claimed standalone child Relay contexts**:

```text
ALL parent issue
  |
  +-- KNEEKURA child issue  ---- independent host semantic session ---- sealed child artifact
  |
  +-- UA child issue        ---- independent host semantic session ---- sealed child artifact
  |
  +-- Archify child issue   ---- independent host semantic session ---- sealed child artifact
  |
  `-- parent composition: receipts + sealed bytes only -> ALL bundle
```

The parent is control-plane only. It never asks a semantic Host Task, never receives a semantic answer intended for an engine, never forwards one engine's semantic response to another engine, and never opens engine semantic output for consensus reasoning. Comparison begins only after all child executions have reached terminal engine results and their sealed artifacts have been verified.

This design preserves the frozen v1 rule that engine agreement is descriptive only and cannot promote canonical truth.

## 2. Why the existing mechanism is not enough

The current core ALL implementation already creates distinct `attemptId` and `semanticContextId` values, sets `freshSemanticContextRequired: true`, binds Host Tasks to engine/attempt/snapshot/scope, and seals each engine before comparison. Those are necessary controls.

They are not sufficient for ChatGPT Web GitHub Relay because one Issue thread can still be processed by one model conversation. Separate IDs inside a shared conversation do not erase prior semantic memory. `docs/github-relay-v1.md` therefore correctly states that declaring `semanticContextMode: "per-engine"` is necessary but not sufficient and that live transport must prove independent semantic host contexts before Relay ALL mode is enabled.

A second existing gap is workflow preparation: the current Relay workflow prepares UA only for `selection: understand-anything` and Archify only for `selection: archify`. A direct `selection: all` engine execution would therefore not have the required pinned upstream roots. The child design avoids special combined preparation: every child reuses its already-proven standalone path and prepares only its own engine.

## 3. Goals

The implementation must guarantee all of the following:

1. All children analyze the exact same canonical target repository, revision, snapshot ID, and scope digest.
2. Each engine is executed through its existing standalone production path.
3. Each child has a distinct semantic host context identity and a distinct Relay issue.
4. Host responses from one child cannot satisfy, resume, or influence another child's Host Tasks through product transport or replay state.
5. The parent can observe only bounded child control metadata, sanitized receipt data, and sealed artifact bytes after terminal completion.
6. Parent comparison is operational metadata only: no semantic fusion, no engine substitution, and no consensus-to-truth promotion.
7. Existing standalone Relay behavior remains unchanged.
8. The final parent bundle is deterministic for identical verified child bytes and metadata.

## 4. Non-goals

This change does not:

- merge semantic claims across engines;
- choose a winning engine;
- create a majority-vote truth layer;
- pass KNEEKURA summaries into UA or Archify;
- pass UA graph/tour content into KNEEKURA or Archify;
- pass Archify Typed IR/diagram content into KNEEKURA or UA;
- replace existing engine locks or standalone acceptance profiles;
- weaken exact snapshot, target instruction-authority, source-read, or artifact-sealing boundaries;
- claim cryptographic proof of a model provider's hidden conversation memory when the provider does not expose a signed session identity.

## 5. Semantic-context assurance model

### 5.1 Context identity

Each child Relay issue is claimed by one host semantic session before semantic tasks may proceed. A child context claim contains:

```text
parent_run_id
child_issue_number
engine_id
host_context_id
assurance_class
```

`host_context_id` is opaque to Code LAB and must be stable for the lifetime of that child. The Relay does not invent it on behalf of the semantic host.

For the ChatGPT Web acceptance path, the assurance class is `OPERATOR_SEPARATED_HOST_SESSION_V1`: the three children are deliberately handled in three separate ChatGPT conversations and the acceptance evidence records three distinct context IDs. This is an operational separation proof, not a cryptographic provider attestation.

If a future host exposes an authenticated provider session ID or signed context attestation, the same contract can add a stronger assurance class without changing engine semantics.

### 5.2 Fail-closed rules

Relay ALL mode remains blocked if:

- a child has no accepted context claim;
- two children claim the same `host_context_id`;
- a claim names the wrong parent run, child issue, or engine;
- a child tries to change context identity after a semantic response has been accepted;
- the host cannot provide the required assurance class for the requested ALL execution.

The error class is `BLOCKED_SEMANTIC_CONTEXT_ISOLATION`.

Distinct GitHub Issue numbers alone are never treated as semantic-context proof.

## 6. Parent and child identity model

### 6.1 Parent

The parent retains the original Relay ALL request and exact target binding. Its plan records:

```text
parent_run_id
selection = all
semantic_context_mode = per-engine
target repository/revision/snapshot/scope
code_lab_revision
engine_lock_digest
children[3]
```

Each child descriptor binds exactly one engine and one child Issue number. Child issue creation is idempotent: repeated parent turns must discover and reuse the same bound child issues rather than create replacements.

### 6.2 Child

A child issue contains a normal single-engine Relay request plus an immutable parent binding:

```text
parent_run_id
parent_issue_number
engine_id
child_slot
```

The child runs the ordinary standalone engine path. It does not use `selection: all` and does not know sibling task/response history.

The three required child slots are exactly:

1. `kneekura`
2. `understand-anything`
3. `archify`

No fourth engine and no substitution are permitted.

### 6.3 Binding invariants

Parent composition rejects any child terminal record whose:

- engine differs from its slot;
- target repository or exact revision differs;
- snapshot ID differs;
- scope digest differs;
- Code LAB runtime revision differs from the parent-authorized runtime;
- engine-lock digest differs;
- parent binding differs;
- child issue number differs;
- artifact digest/byte count differs from downloaded bytes.

## 7. GitHub Relay lifecycle

### 7.1 Parent creation turn

On an authorized parent Issue with `selection: all` and `semanticContextMode: per-engine`:

1. validate the exact target request;
2. resolve the exact target snapshot and scope exactly as standalone Relay does;
3. emit the immutable parent plan;
4. create or recover exactly three child Issues;
5. bind one child Issue to each engine;
6. publish a bounded `ALL_CONTEXTS_REQUIRED` parent message listing the three child Issues and their engine slots;
7. stop without invoking any engine.

Child issues created by the workflow token are not expected to recursively trigger the Relay workflow. A child starts only after an allowed external actor posts a context-claim comment. This avoids accidental GitHub event recursion and makes semantic-context activation explicit.

### 7.2 Child claim and execution

A child external context posts `KNEEKURA_RELAY_CONTEXT_CLAIM_V1` with its context identity. The child workflow:

1. verifies immutable parent/child binding;
2. ensures the context ID is not already bound to a sibling;
3. persists the accepted context claim in the GitHub transport ledger;
4. executes the existing standalone Relay replay loop for its single engine;
5. accepts only responses bound to that child run/engine/attempt/snapshot/scope/task;
6. produces a terminal child result and sealed child artifact.

Every later semantic response on that child must be compatible with the accepted context claim. A conflicting re-claim fails closed.

### 7.3 Parent composition turn

The parent does not auto-compose from workflow-token child comments. Composition is triggered by an allowed external parent resume/compose comment after the three children are terminal.

The parent then:

1. reads only the immutable child binding and each terminal child result envelope;
2. downloads each child Actions artifact by its exact run/artifact locator;
3. verifies artifact digest and byte count;
4. obtains the bounded sanitized engine receipt associated with the child sealed artifact;
5. verifies receipt engine/snapshot/scope/runtime/lock bindings;
6. confirms the three host context IDs are distinct;
7. composes the ALL bundle from the three already-sealed child outcomes;
8. uploads the parent sealed ALL bundle;
9. publishes a bounded parent terminal result.

The parent collector must not parse child semantic Task or Response comments. Those comments are outside its input allowlist.

## 8. Child sealed result contract

Standalone child success must expose enough bounded material for later parent verification without exposing raw engine internals in Issue comments.

Each child Actions artifact will contain:

```text
result.zip                 # existing sealed engine delivery ZIP
engine-receipt.json        # sanitized receipt bound to result.zip
child-result-manifest.json # child/parent/context/runtime/artifact identities
```

The outer Actions artifact is transport packaging only. The digest recorded in the Relay terminal result continues to bind the engine `result.zip` bytes. The manifest additionally binds the receipt digest and context identity.

The parent never modifies a child `result.zip`. It embeds those exact verified bytes into the final ALL delivery bundle.

## 9. Parent composition contract

The core ALL bundler should be split conceptually into two stages:

1. **engine execution -> sealed outcome** (existing local/in-process behavior);
2. **sealed outcomes -> deterministic ALL bundle** (reusable by both local ALL and GitHub Relay parent composition).

A new sealed-outcome composer accepts exactly three verified outcomes and produces the same operational comparison policy:

```text
semantic_fusion = false
canonical_truth_promotion = false
engine_substitution = false
comparison_policy = sealed-operational-metadata-only
```

The composer has no semantic scheduler, source broker, repository reader, or Host Task API. It receives only verified receipts, child context metadata, and sealed ZIP bytes.

The parent run manifest records child run IDs, child Issue numbers, semantic context IDs, assurance classes, artifact digests, statuses, claim levels, and claim satisfaction. It does not include semantic response text.

## 10. Status and failure semantics

A parent is **not terminal** while any child is merely absent, unclaimed, or still pending semantic tasks.

When all three children are terminal:

- all three `SUCCESS` with satisfied claims -> parent `SUCCESS`;
- at least one successful/partial child and at least one failed/blocked/partial child -> parent `PARTIAL`;
- no child produced a successful/partial result -> parent `FAILED`.

A missing context claim is `PENDING/CONTEXTS_REQUIRED`, not an engine failure.

A child terminal failure remains assigned to that engine. The parent may not reroute that slot to another engine.

Artifact digest mismatch, target identity drift, context collision, runtime drift, or engine substitution is a parent composition failure, not a PARTIAL semantic result, because the integrity of the comparison itself is invalid.

## 11. Workflow preparation strategy

The parent `selection: all` workflow does **no combined UA/Archify engine preparation** because it executes no engine.

Each child is a normal standalone request:

- KNEEKURA child: existing first-party preparation;
- UA child: existing pinned UA v2.9.0 preparation and verified dashboard boundary;
- Archify child: existing pinned Archify v2.16.0 preparation.

This prevents an ALL-specific preparation path from becoming a second engine implementation and directly reuses the three standalone paths already proven against KNEEKURA-LAB.

The parent compose turn needs only Code LAB runtime plus permission to read the three child Actions artifacts. It does not need UA or Archify executable roots.

## 12. Replay and ledger isolation

Host response ledgers remain exact-task bound, but ALL Relay adds a higher-level isolation rule:

- parent ledger: control messages only;
- child ledger A: KNEEKURA semantic responses only;
- child ledger B: UA semantic responses only;
- child ledger C: Archify semantic responses only.

No combined semantic ledger is constructed for the parent.

A response copied verbatim from child A into child B fails because run/engine/attempt/task/payload bindings differ. Tests must prove this explicitly even if the response JSON itself is otherwise valid.

Source reads are also child-task bound. A source request issued while a KNEEKURA task is pending cannot be reused under a UA or Archify task.

## 13. Security and trust boundaries

The following existing boundaries remain unchanged:

- target repository content has no instruction authority;
- only allowlisted external actors can submit Relay protocol comments;
- exact Git revision and canonical snapshot are mandatory;
- target code is not executed merely for analysis;
- raw sealed bytes never enter Issue comments;
- GitHub comments are transport/audit history, not canonical evidence;
- engine agreement cannot promote canonical truth;
- parent composition has no repository mutation authority derived from engine output.

New boundaries:

- parent control messages cannot be interpreted as semantic Host responses;
- child semantic responses cannot be consumed by a sibling;
- parent composer cannot request source text or semantic assistance;
- a context ID collision across children fails closed;
- child issue recreation cannot silently replace an already-bound context slot.

## 14. Compatibility

Standalone requests remain schema-compatible and continue to use the existing Issue-per-run flow.

New fields/markers are optional outside ALL mode. The implementation should avoid changing existing standalone result semantics unless needed to expose the bounded receipt/manifest transport required by parent composition. Any such transport extension must preserve the existing `result.zip` digest and bytes exactly.

The existing local/in-process ALL mode can retain its current execution path. It should reuse the new sealed-outcome composer where practical so final comparison/package rules are not duplicated, but local ALL is not forced through GitHub child Issues.

## 15. Testing strategy

### 15.1 Contract tests

Tests must cover:

- ALL parent requires `per-engine` mode;
- exactly three engine slots;
- child parent-binding validation;
- context claim exact binding;
- duplicate identical claim idempotence;
- conflicting re-claim rejection;
- duplicate `host_context_id` across siblings rejection;
- child target/runtime/engine-lock drift rejection.

### 15.2 Replay isolation tests

Tests must prove:

- KNEEKURA response cannot satisfy UA task;
- UA response cannot satisfy Archify task;
- Archify response cannot satisfy KNEEKURA task;
- source request cannot cross child boundaries;
- parent collector ignores semantic task/response bodies;
- parent never creates a semantic Host Task.

### 15.3 Composer tests

Tests must prove:

- exactly three sealed children are required;
- one child per engine, no substitution;
- same snapshot/scope/runtime/engine-lock required;
- child ZIP digest and receipt binding verified;
- comparison remains metadata-only;
- identical verified inputs produce byte-identical parent bundles;
- failure/partial status calculation matches the frozen ALL policy.

### 15.4 Workflow tests

Tests must prove:

- parent ALL turn does not run UA or Archify preparation;
- UA child still uses pinned UA preparation;
- Archify child still uses pinned Archify preparation;
- parent has only the permissions needed to create/read Issues and read child Actions artifacts;
- workflow-token child issue creation does not rely on recursive workflow triggering;
- an external child context claim is the activation event.

## 16. Real acceptance

The final acceptance target remains the exact KNEEKURA-LAB revision already used for standalone proof:

`e96e40ab0fc7a8995a1972d8f9defb2aa894ad0e`

Acceptance requires:

1. one parent ALL Issue;
2. three child Issues, exactly one per engine;
3. three deliberately separate host semantic sessions with distinct context IDs;
4. each child independently reaches a terminal sealed result through its standalone path;
5. no child semantic response is posted to or consumed by another child;
6. parent downloads and verifies all three child artifacts;
7. parent produces one deterministic sealed ALL bundle;
8. parent manifest proves same target snapshot/scope and distinct context identities;
9. parent comparison proves `semantic_fusion=false`, `canonical_truth_promotion=false`, and `engine_substitution=false`;
10. an adversarial replay test demonstrates that cross-child response reuse is rejected.

The acceptance record must explicitly state that the ChatGPT Web context separation is operator-attested unless/until the host exposes a stronger provider-authenticated context identity.

## 17. Adversarial design review

The design was checked against the primary failure modes before freezing:

| Attack/failure | Required defense |
| --- | --- |
| Three Issues handled by one semantic conversation | Distinct host context claims are required; Issue number alone is insufficient. |
| Same context claims two engine children | Parent/child claim registry rejects context ID collision. |
| Parent accidentally becomes a semantic agent | Parent has no Host Task API and never consumes semantic response envelopes. |
| KNEEKURA answer copied into UA | Exact run/engine/attempt/task/payload binding rejects it. |
| Engine result influences next engine prompt | Children execute independently; sibling results are unavailable until parent composition. |
| Parent uses majority vote as truth | Comparison contract keeps fusion and truth promotion false. |
| Failed UA replaced by Archify | Exactly one fixed slot per engine; substitution remains forbidden. |
| Child analyzes a different commit | Parent rejects repository/revision/snapshot/scope mismatch. |
| Child runs a different Code LAB runtime | Parent rejects runtime or engine-lock mismatch. |
| Child artifact changed after result comment | Parent recomputes artifact digest and byte count before composition. |
| Workflow-created child Issue never starts | This is intentional; external context claim is the child activation event. |
| ALL path forgets UA/Archify prep | Parent runs no engine; each standalone child performs its proven engine-specific prep. |
| Repeated parent turn creates extra children | Child slot bindings are idempotent and immutable. |
| Missing child is misreported as engine failure | Parent remains CONTEXTS_REQUIRED/PENDING until every child is terminal. |
| Parent scans child semantic comments | Collector allowlist accepts only binding, context claim, terminal result, and artifact metadata. |

No Critical/High design issue remains unresolved in this frozen design. The principal residual limitation is explicit: `OPERATOR_SEPARATED_HOST_SESSION_V1` is operational evidence, not a cryptographically signed model-provider session attestation.

## 18. Implementation boundary

Implementation must start with tests and contracts, not workflow activation. The order is:

1. schema/context/child-binding contract tests;
2. sealed-outcome composer extraction and tests;
3. parent/child Relay orchestration tests;
4. child result receipt/manifest transport;
5. workflow permission/preparation changes;
6. isolated fixture acceptance;
7. real three-context KNEEKURA-LAB acceptance;
8. only then enable GitHub Relay ALL mode as accepted behavior.

Until step 7 passes, `selection: all` must continue to fail closed or return a non-terminal context-requirement state. No implementation step may silently downgrade the separation requirement to shared-context sequential execution.