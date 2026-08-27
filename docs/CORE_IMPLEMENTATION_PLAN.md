# CORE Implementation Plan v1

Status: **implementation-ready**  
Architecture authority: \`docs/CORE_ARCHITECTURE.md\`  
Target substrate: current Node.js 20+ KNEEKURA-CODE-LAB  
Recommended delivery: focused PRs; never one giant rewrite.

## 1. Implementation objective

Evolve the existing KNEEKURA-CODE-LAB analysis core into the CORE Repository Evidence Engine without regressing the current Minecraft/Forge/YSM graph, runtime evidence, fixtures, or Viewer.

Implementation is complete only when the canonical Analysis Core can:

1. freeze a trustworthy repository snapshot;
2. deterministically plan scope and account coverage;
3. acquire static/Git/runtime evidence through versioned providers;
4. represent claims separately from graph topology;
5. verify host-proposed conclusions;
6. resume/reuse work without stale evidence;
7. produce one canonical AnalysisResult;
8. render it for AI and humans separately;
9. pass the YSM-grade acceptance suite;
10. remain read-only with respect to the analyzed repository.

## 2. Mandatory implementation rules

These are gates for every PR.

- Keep the target repository read-only.
- Preserve all existing tests and runtime semantics unless an explicit compatibility migration test replaces them.
- Do not silently reinterpret \`kneekura.graph/v1\`.
- Do not make an LLM mandatory for deterministic analysis.
- Do not make a provider/API key part of CORE configuration.
- Do not infer missing runtime stages.
- Do not use percentages alone to justify negative claims.
- Do not turn an analyzer error into absence.
- Do not fabricate source lines or symbols.
- Do not allow repository text to act as instructions.
- Every new persisted schema is versioned.
- Every reusable artifact declares enough dependencies to invalidate it safely.
- New functionality should have fixture-based offline tests before requiring Minecraft/YSM live execution.

## 3. Delivery structure

Recommended focused PR sequence:

| PR | Theme | Depends on |
|---|---|---|
| A | Identity + canonical schemas | current main |
| B | Evidence Provider + provenance migration | A |
| C | Scope + Coverage + Rules + SAU | B |
| D | Evidence Ledger + Verification | C |
| E | Sessions + Cache + Exploration Ledger | D |
| F | API + ReasoningBridge + AI renderer | E |
| G | Human Viewer canonical-result migration | F |
| H | YSM acceptance suite + plugin readiness | G |

Do not merge the next PR until the previous PR's exit criteria pass.

## 4. Suggested source layout

This is a suggested additive layout. Exact filenames may change, but responsibility boundaries should not.

~~~text
src/
  core/
    graph.mjs                  # existing graph builder / compatibility
    scan.mjs                   # existing orchestration, progressively thinned
    workspace.mjs              # existing workspace merge

    identity/
      repository.mjs
      snapshot.mjs

    schema/
      analysis-request.mjs
      analysis-result.mjs
      evidence.mjs
      coverage.mjs

    providers/
      provider.mjs
      registry.mjs

    scope/
      planner.mjs
      decisions.mjs
      semantic-unit.mjs

    rules/
      resolver.mjs

    ledger/
      evidence-store.mjs
      claims.mjs
      derivations.mjs

    verify/
      verifier.mjs
      snapshot.mjs
      anchor.mjs
      path.mjs
      counterevidence.mjs
      runtime.mjs
      coverage.mjs
      negative.mjs

    session/
      session.mjs
      events.mjs
      resume.mjs
      exploration-ledger.mjs

    cache/
      store.mjs
      keys.mjs
      dependencies.mjs

    api/
      analyze.mjs
      expand.mjs
      get.mjs

    reasoning/
      bridge.mjs
      capsule.mjs

    render/
      ai.mjs
      json.mjs
      human-model.mjs

  analyzers/                  # current domain analyzers, preserved
  adapters/                   # current runtime/external adapters, preserved
  semantics/                  # optional later extraction of domain ontology

schemas/
  core.evidence.v1.json
  core.analysis-request.v1.json
  core.analysis-result.v1.json
  core.coverage.v1.json

fixtures/
  core/
    identity/
    coverage/
    claims/
    sessions/
    cache/
    trust/
    ysm/
~~~

The implementation should avoid a cosmetic file move before behavior is protected by tests.

## 5. Milestone A — Repository/Snapshot Identity and schemas

### A1. RepositoryIdentity

Implement canonical repository identity.

Inputs:

- repository root;
- Git metadata;
- canonical remote if available;
- fallback Git identity if no remote.

Output:

~~~text
RepositoryIdentity {
  schema
  vcs
  canonical_identity
  repository_id   # cryptographic digest
}
~~~

Requirements:

- no lossy path replacement;
- Windows/Linux path spelling does not change a remote-backed repository ID;
- two unrelated local repositories must not collide under normal operation;
- identity calculation is read-only.

Tests:

- Windows-style vs POSIX path representation;
- same remote in normalized URL forms;
- no-remote fallback;
- two unrelated repos;
- malformed Git metadata.

### A2. SnapshotIdentity

Implement:

- COMMIT;
- WORKSPACE;
- MULTI_REPO;
- ARCHIVE when needed by existing adapters.

Workspace freeze produces a content manifest.

Recommended shape:

~~~text
SnapshotIdentity {
  schema
  kind
  repository_id
  base_commit?
  content_manifest_digest
  constituents?
}
~~~

The content manifest should include path + state + digest for relevant workspace files.

Tests:

- clean commit;
- modified tracked file;
- untracked file;
- deleted file;
- two workspace states on same HEAD produce different snapshot IDs;
- multi-repo constituent change changes workspace snapshot.

### A3. Canonical schema validators

Add v1 validators for:

- AnalysisRequest;
- AnalysisResult;
- EvidenceRecord;
- ClaimRecord;
- Coverage Manifest.

Prefer explicit small validators consistent with the repository's dependency-light philosophy. A new schema-validation dependency requires justification.

### A4. Compatibility metadata

Current \`kneekura.graph/v1\` output remains accepted.

Add snapshot/repository metadata without changing the meaning of existing graph nodes/edges.

### Milestone A exit

- all existing tests pass;
- identity fixtures pass;
- identical source produces stable identities;
- workspace mutation cannot remain invisible;
- schemas reject malformed enum/state combinations.

## 6. Milestone B — Evidence Provider interface and provenance

### B1. Provider interface

Introduce an internal contract similar to:

~~~text
EvidenceProvider {
  id
  version
  capabilities()
  dependencyFingerprint(context)
  acquire(context, unit) -> ProviderResult
}
~~~

\`ProviderResult\` contains:

- EvidenceRecords;
- graph fragments;
- diagnostics/failures;
- unresolved references;
- provider metrics.

### B2. Wrap existing analyzers incrementally

Do not rewrite analyzers first.

Create wrappers for current:

- Java lexical analyzer;
- Forge semantics;
- Forge network semantics;
- Minecraft/YSM semantics;
- CodeGraph adapter;
- Understand Anything adapter;
- runtime trace;
- pose;
- palette;
- network companion.

Each wrapper must identify provider version and provenance.

### B3. Provenance anchors

Every evidence-producing path should eventually emit:

- snapshot ID;
- provider ID/version;
- source path/artifact;
- symbol/range when known;
- artifact/run ID when runtime.

Existing graph \`evidence\` strings may remain for compatibility, but canonical EvidenceRecord becomes the authority.

### B4. Unresolved handling

Convert existing unresolved behavior into explicit evidence/graph state.

Tests must prove:

- unresolved import remains unresolved;
- missing runtime static match does not create a fabricated static node;
- unknown line range stays absent rather than zero-as-truth.

### Milestone B exit

- existing KNEEKURA graphs still render;
- at least Java + runtime-network paths emit canonical EvidenceRecords;
- every canonical evidence item has snapshot/provider provenance;
- provider failures are typed, not converted to “no result”.

## 7. Milestone C — Scope, Coverage, Rule Resolver, Semantic Analysis Units

### C1. Scope Planner

Implement deterministic seed resolution.

Supported first seeds:

- path;
- exact symbol;
- ambiguous symbol candidate set;
- diff file;
- graph node ID;
- runtime artifact/entity ref.

Every expansion writes a ScopeDecision.

### C2. Coverage Manifest builder

Implement separate role/status fields.

Roles:

- PRIMARY
- DEPENDENCY
- SUPPORTING_CONTEXT
- RUNTIME_ARTIFACT

Statuses:

- PENDING
- ANALYZED
- REUSED
- SKIPPED
- FAILED
- UNEXPLORED

Implement a finalize backstop inspired by the strongest property of OpenCodeReview manifests: no known selected item silently remains pending at close.

Unlike a review-only manifest, CORE must retain the reason a known item is unexplored.

Completeness calculator:

- COMPLETE;
- BOUNDED;
- PARTIAL;
- UNKNOWN.

Tests:

- selected set fully partitioned;
- analyzer failure -> PARTIAL;
- unenumerable resolver -> UNKNOWN;
- explicit depth horizon -> BOUNDED;
- complete local symbol universe -> COMPLETE.

### C3. Rule Resolver

Start with current built-in language/platform semantics and repository rules.

Output:

~~~text
RuleResolution {
  applied[]
  rejected[]
  resolution_fingerprint
}
~~~

Every item includes reason and source/hash.

Do not send the full rule corpus to ReasoningBridge.

### C4. Semantic Analysis Units

Build SAUs from deterministic graph/semantic relationships.

Initial grouping heuristics should use strong evidence such as:

- definition/reference;
- caller/callee;
- implementation/interface;
- packet registration/send/handler;
- resource references;
- shared Molang/animation/bone contracts;
- test-to-target links.

Do not use Git co-change as an exact semantic edge. If added later, mark it correlated/supporting.

Fallback:

- if graph confidence is insufficient, produce smaller units;
- never ask an LLM to decide the authoritative unit.

Tests:

- service/repository/config/resource fixture groups as one unit when linked;
- unrelated files do not group;
- ambiguous candidate creates multiple candidate units or explicit unresolved boundary;
- token/size split preserves coverage for every item.

### Milestone C exit

- every analysis starts with a Coverage Manifest;
- every scope decision is explainable;
- SAUs are deterministic for the same snapshot/config;
- no LLM is required;
- negative claims are still disabled until Milestone D verifier exists.

## 8. Milestone D — Evidence Ledger and Verification

### D1. Evidence store

Create immutable EvidenceRecord storage keyed by content-derived or stable event identity.

Deduplicate identical evidence observations while preserving distinct runtime runs/artifacts.

### D2. Claims

Implement ClaimRecord and ClaimEvidenceLink.

Enforce construction rules:

- OBSERVED needs evidence;
- DERIVED needs derivation rule + dependencies;
- INFERRED begins PROPOSED;
- HYPOTHESIS cannot be VERIFIED as a factual observation without promotion into a new appropriately typed claim;
- UNKNOWN can exist with no supporting evidence but must contain unresolved reason;
- NEGATIVE begins gated/unverified.

### D3. Deterministic derivations

Migrate known safe derivations first.

Example:

- observed client command handler returned true
  -> DERIVED: client command path consumed the command.

Do **not** add:

- consumed
  -> YSM Molang state applied.

That needs runtime M6 evidence.

### D4. Verifier pipeline

Implement the verifier chain from Architecture §19.

Verifier API should return machine records, not throw away evidence on failure.

Suggested:

~~~text
VerificationRecord {
  verifier_id
  verifier_version
  status
  checked_refs[]
  findings[]
}
~~~

### D5. Negative gate

Implement as code, not prompt wording.

The gate consumes:

- searched property;
- provider capability;
- search universe;
- coverage;
- stale status;
- counterevidence.

Tests:

1. full universe, absent property -> NEGATIVE VERIFIED;
2. one unexplored relevant file -> no NEGATIVE;
3. analyzer unsupported -> UNKNOWN;
4. analyzer failed -> UNKNOWN/PARTIAL;
5. stale snapshot -> no NEGATIVE.

### D6. Counterevidence

Allow one evidence item to contradict a claim without deleting the original support.

Verifier outcome should become:

- VERIFIED;
- VERIFIED_WITH_LIMITS;
- REJECTED;
- UNRESOLVED.

### Milestone D exit

- M5/M6 regression passes;
- send/receive regression passes;
- strong negative claims are impossible without code gate;
- host-like ProposedClaims can be rejected deterministically;
- final conclusions can be reconstructed from Ledger without renderer prose.

## 9. Milestone E — Sessions, cache, invalidation, Exploration Ledger

### E1. Session event log

Persist append-only events under CORE-owned storage, not target repository.

Events should include at least:

- session start;
- snapshot frozen;
- scope decision;
- provider started/completed/failed;
- evidence stored/reused;
- claim proposed/verified/rejected;
- coverage changed;
- session finalized.

A materialized state may be rebuilt from the event log.

### E2. Cache tiers

Implement C0-C4 in order.

Start with C0/C1 because they provide the largest safe reuse with the smallest semantic risk.

Do not optimize C4 before dependency fingerprints are trustworthy.

### E3. Dependency fingerprints

Each cached artifact declares dependencies.

Examples:

- Java parse fact:
  file digest + java analyzer version.

- Forge semantic fact:
  Java parse artifact + Forge analyzer version + platform profile.

- runtime join:
  static node identity + runtime artifact digest + identity matcher version.

- verified claim:
  evidence IDs + coverage manifest fingerprint + verifier versions + rule dependencies.

### E4. Exploration Ledger

Before reading/acquiring:

- check whether valid evidence of sufficient fidelity already exists;
- reuse by ID;
- only reacquire when stale, missing, or higher fidelity explicitly requested.

### E5. Cross-snapshot child session

Implement:

~~~text
parent_session_id
target_snapshot_id
reused_evidence_ids[]
invalidated_evidence_ids[]
~~~

Never reuse a conclusion solely because a path matches.

### E6. Metrics

Record:

- provider acquisitions;
- provider reuse count;
- evidence IDs sent to ReasoningBridge;
- raw excerpt bytes/tokens packed;
- cache hits/misses;
- invalidation reasons;
- coverage expansion count.

These metrics prove token savings without provider-price coupling.

### Milestone E exit

- same snapshot rerun reuses unchanged deterministic evidence;
- one-file change preserves unrelated C1 cache;
- stale dependent claims are invalidated;
- no target-repository writes;
- session replay reproduces terminal coverage/claims.

## 10. Milestone F — Public API, ReasoningBridge, AI renderer

### F1. core.analyze

Implement the canonical orchestration.

Pseudo-flow:

~~~text
validate request
freeze snapshot
resolve scope
resolve rules
build SAUs
acquire/reuse evidence
derive deterministic claims
if reasoning needed and bridge exists:
    build Evidence Capsule
    receive ProposedClaims
verify
finalize coverage
return AnalysisResult
~~~

No renderer-specific decisions inside analysis.

### F2. core.expand

Use an existing AnalysisSession and add bounded scope/evidence around:

- symbol;
- evidence;
- claim;
- graph node/path.

Expansion must update Coverage and Session state.

### F3. core.get

Stable ref lookup for:

- claim;
- evidence;
- graph node;
- artifact.

### F4. ReasoningBridge

Define an interface only.

Do not implement provider credentials.

A test bridge should return deterministic fixtures.

Required tests:

- bridge absent;
- bridge proposes valid claim;
- bridge proposes unsupported claim;
- bridge attempts negative claim without coverage;
- bridge proposes exact symbol not in candidate set.

### F5. Evidence Capsule

Capsule packer must:

- deduplicate evidence IDs;
- include coverage/unknown constraints;
- include only matched rules;
- include minimal source anchors;
- preserve counterevidence;
- support compact/standard/forensic budgets.

Never replace source evidence with only an LLM summary.

### F6. AI renderer

Implement canonical dense sections.

Golden-test rendering to ensure:

- PARTIAL remains visible;
- UNKNOWN remains visible;
- M5/no-M6 qualifier remains;
- evidence IDs are stable;
- compact mode does not alter claim semantics.

### F7. Jolly Research Mailbox adapter

Treat the mailbox service as one consumer.

It can map AnalysisResult into the existing low-token mailbox format, but mailbox wording must not become the CORE canonical schema.

### Milestone F exit

- a fake host adapter can execute diagnose/trace through core.analyze;
- unsupported host claims are rejected;
- deterministic analyze works with no host;
- API surface stays small;
- AI output is measurably smaller than dumping source/graph while preserving claim qualifiers.

## 11. Milestone G — Human Viewer migration

### G1. Add canonical result loader

Viewer should load:

- AnalysisResult;
- graph refs;
- Evidence Ledger refs;
- Coverage Manifest.

Keep current graph-file loading during transition.

### G2. Required panels

Implement or adapt:

- architecture graph;
- selected node details;
- responsibility;
- callers/callees;
- domain semantic edges;
- runtime overlay;
- claim/evidence/counterevidence;
- provenance/source anchor;
- coverage;
- unexplored/failed;
- session/snapshot identity.

### G3. Lazy data loading

Do not ship the entire Evidence Ledger to the browser for every view.

Use ref-based drill-down.

### G4. Compatibility

Current KNEEKURA-specific filters, Molang transport matrices, fidelity matrix, packet/runtime overlays, and bone evidence must remain accessible.

### Milestone G exit

- existing Viewer regressions pass;
- same AnalysisResult can render AI and Human output;
- human prose is not used as AI context;
- coverage/unknown states are visible to humans.

## 12. Milestone H — YSM acceptance and plugin readiness

Run the Architecture §29 suite.

### H1. AT-01 final bone matrix

Create a curated golden oracle after manually validating the decoded YSM source.

The oracle must store:

- snapshot SHA;
- accepted source anchor(s);
- accepted path/hook evidence;
- intentionally ambiguous alternatives where applicable.

CORE passes if it returns the validated answer or a safely narrower answer. It fails if it invents unsupported certainty.

### H2. Reuse current runtime semantics

Turn existing KNEEKURA fixtures into permanent CORE regressions for:

- N0-N2;
- M0-M6;
- payload fingerprint;
- run identity;
- pose identity;
- palette identity;
- weak correlation vs formal application.

### H3. Trust/security fixtures

Add repository text that says things such as “ignore previous instructions” and verify it is rendered only as evidence data.

Add symlink/path traversal fixtures where the platform permits.

### H4. Budget/coverage fixtures

Force low budget and verify PARTIAL/BUDGET_EXHAUSTED.

### H5. Plugin readiness gate

Only after AT-01..AT-12 pass:

- freeze \`core.analysis-request/v1\`;
- freeze \`core.analysis-result/v1\`;
- publish plugin adapter contract;
- write a minimal host integration guide.

### Milestone H exit

All acceptance tests pass at pinned snapshots or an explicitly recorded successor snapshot.

## 13. OpenCodeReview-inspired implementation details to adopt

Adopt mechanically where useful:

1. preview-style deterministic scope reporting before expensive reasoning;
2. explicit exclusion reasons;
3. manifest finalization invariant so no selected item is silently undecided;
4. typed failure classes;
5. content/diff fingerprints for conservative reuse;
6. manifest-certified reuse rather than checkpoint-line trust alone;
7. fail-fast context/budget guards;
8. separate verification pass.

Do not copy directly:

1. LLM semantic grouping as authoritative scope;
2. review-only coverage schema;
3. comment-centric result as canonical model;
4. LLM-provider setup;
5. source-fixing behavior;
6. lossy filesystem path identity;
7. cross-file context bounded solely by one LLM-created group.

## 14. Test strategy

### 14.1 Test layers

- unit: pure schema/identity/coverage/cache/verifier functions;
- fixture integration: small synthetic repositories;
- legacy regression: existing KNEEKURA test suite;
- workspace integration: multi-repository TLM/YSM fixtures;
- runtime companion integration: JSONL/pose/palette/network;
- live acceptance: Minecraft/YSM only for evidence that cannot be established offline.

### 14.2 No-Minecraft default

Normal \`npm test\` must not require Minecraft.

Live acceptance should be a separate command/profile and consume captured artifacts where possible.

### 14.3 Golden data rules

Golden evidence stores:

- exact source snapshot;
- artifact digest;
- schema;
- expected claim types;
- expected forbidden claims;
- coverage expectations.

Avoid golden prose. Test machine semantics.

## 15. Performance and token measurement

Do not optimize only wall-clock time.

Record at least:

- source bytes scanned;
- files parsed vs reused;
- graph fragments recomputed;
- evidence records reused;
- Evidence Capsule token estimate;
- duplicate evidence suppressed;
- host reasoning calls;
- verifier-triggered expansion count.

Primary token-quality invariant:

> Warm-cache reuse must reduce repeated evidence transmission without weakening claim verification or hiding coverage.

Do not set a hard token-reduction percentage until baseline measurements exist.

## 16. Compatibility rules

During migration:

- \`kneekura.graph/v1\` remains readable;
- current CLI scan/workspace commands keep working;
- current Viewer remains usable;
- existing domain edge types remain available through compatibility;
- existing M0-M6 semantics are not renamed without adapter coverage;
- \`unobserved != failed\` behavior is permanent;
- runtime run-identity gates may only become stricter, never silently weaker.

## 17. Failure and rollback policy

Every focused PR should be independently revertible.

If a migration phase breaks existing analysis:

1. keep old path behind compatibility adapter;
2. disable only the new canonical path;
3. preserve captured evidence and sessions;
4. do not rewrite old session files in place.

Schema migration is append/new-version, not destructive overwrite.

## 18. Definition of Done mapping

| Architecture DoD | Implementation proof |
|---|---|
| Responsibilities/non-responsibilities | API has no write/fix/provider-management surface |
| Repository Evidence Engine | canonical AnalysisResult contains claims/evidence/coverage beyond review |
| OCR influence reasoned | §13 + architecture influence section |
| Deterministic vs LLM | ReasoningBridge cannot mint authoritative evidence/coverage |
| Claim types | schema + construction tests |
| Coverage semantics | Coverage builder/finalizer tests |
| Negative condition | coded negative verifier tests |
| Unified graph | canonical node/edge + domain namespace tests |
| Snapshot/provenance | Identity + provenance fixtures |
| Session/cache | replay/reuse/invalidation tests |
| Token strategy | Exploration Ledger + capsule metrics |
| Renderer split | one AnalysisResult -> AI and Human outputs |
| Small API | analyze/expand/get/session.resume only |
| Read-only | write-boundary tests and no mutation API |
| Runtime evidence | M0-M6/N0-N2/pose/palette/network regressions |
| YSM acceptance | AT-01..AT-12 |
| Codex implementation-ready | this phased plan + exit criteria |

## 19. First implementation slice for Codex

The first coding task should be **PR A only**.

Exact first slice:

1. add RepositoryIdentity;
2. add COMMIT and WORKSPACE SnapshotIdentity;
3. add versioned AnalysisRequest/AnalysisResult/Evidence/Coverage validators;
4. attach repository/snapshot metadata to scan output without changing existing graph meaning;
5. add identity/workspace-race fixtures;
6. run all existing tests;
7. document compatibility.

Do **not** implement the Ledger, LLM bridge, cache, Viewer rewrite, or plugin in PR A.

This keeps the first change small enough to review and establishes the identity guarantees everything else depends on.

## 20. Final implementation order

The implementation order is therefore frozen as:

~~~text
Identity/Schemas
    ->
Evidence Providers/Provenance
    ->
Scope/Coverage/Rules/SAU
    ->
Ledger/Verification
    ->
Sessions/Cache/Exploration Ledger
    ->
API/ReasoningBridge/AI Renderer
    ->
Human Viewer
    ->
YSM Acceptance
    ->
Plugin freeze
~~~

Skipping ahead is allowed only when the dependency contract is already implemented and tested. Otherwise later layers would encode assumptions that the earlier guarantees were designed to prevent.
