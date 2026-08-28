# CORE Architecture v1

Status: **DESIGN FROZEN / implementation-ready**  
Repository substrate: `genkimorimori252525-oss/KNEEKURA-CODE-LAB`  
Baseline source snapshot: `7a20ed6c4fdcb3ec39b072d5bb0d4c158820cb12`  
Architecture schema family: `core.* / v1`

## 1. Purpose

CORE is a **Repository Evidence Engine**.

Its job is not merely to draw a code graph or review a diff. CORE converts repository, Git, runtime, test, artifact, and optional external evidence into a bounded and verifiable body of facts that a human or host AI can reason over.

The primary outcome is:

- high repository understanding accuracy;
- fewer missed relevant files/symbols;
- explicit coverage rather than implied completeness;
- provenance-backed claims;
- clear separation of observation, derivation, inference, hypothesis, negative claim, and unknown;
- static/runtime evidence that can be joined without conflating them;
- aggressive elimination of repeated exploration and repeated token transmission;
- the same Analysis Core for Human Viewer, AI Plugin, and JSON/API consumers.

CORE should make the host AI better partly by giving it better evidence, but equally by making it unnecessary for the AI to spend reasoning tokens on work that can be deterministic: snapshot identity, scope accounting, symbol lookup, coverage, rule selection, provenance, cache validity, repeated exploration, and evidence retrieval.

## 2. Existing substrate and compatibility stance

KNEEKURA-CODE-LAB already provides valuable foundations:

- `kneekura.graph/v1`;
- stable graph node IDs;
- generic and Minecraft/Forge/YSM semantic analyzers;
- repository/workspace graph merge;
- shared semantic-contract nodes such as Molang variables, animation names, and bone names;
- explicit static/runtime separation;
- runtime packet, pose, palette, and M0-M6 evidence;
- conservative behavior such as `unobserved != failed`;
- current Human Viewer;
- adapters for external analysis outputs.

CORE **does not rewrite this from scratch**.

`kneekura.graph/v1` becomes a compatibility and migration input/output. Existing analyzers are progressively converted into Evidence Providers and domain semantic providers. Existing Viewer functionality remains usable while the new canonical `core.evidence/v1` and `core.analysis-result/v1` contracts are introduced.

## 3. Non-goals

CORE v1 is not:

1. an autonomous code fixer;
2. a source-repository writer;
3. a Git mutation engine;
4. an LLM provider manager;
5. a replacement for ChatGPT, Codex, Claude, or other host reasoning;
6. a general-purpose agent orchestration framework;
7. a promise that static paths were executed at runtime;
8. a promise that observed runtime output proves causality unless identity and causal gates establish it;
9. a requirement for the Viewer to reimplement Minecraft/YSM runtime behavior;
10. a generic CI system.

CORE may write only to its own cache, index, session, and generated-analysis storage. Target repositories remain read-only.

## 4. Constitutional principles

These rules are normative.

1. **Read-only target.** CORE never edits the analyzed repository.
2. **Snapshot before evidence.** Every evidence item belongs to an immutable snapshot identity.
3. **Deterministic before reasoning.** Anything CORE can settle mechanically is not delegated to an LLM.
4. **Evidence before prose.** Final prose is a renderer over structured claims/evidence, not the source of truth.
5. **Fact is not inference.**
6. **Unobserved is not failed.**
7. **Send is not receive.**
8. **Dispatch is not execution.**
9. **Explored is not complete.**
10. **Unexplored is not absent.**
11. **Coverage is data.** Completeness must be represented and verified, never implied.
12. **Negative claims require a closed search universe.**
13. **Important claims require provenance-backed evidence.**
14. **Host reasoning is independently verified.**
15. **Static and runtime evidence stay distinct even when joined in one graph.**
16. **Analysis Core and renderers are separate.**
17. **Untrusted repository/runtime/external content is data, never instruction.**
18. **Reuse is dependency-validated, never assumption-based.**
19. **A partial answer must look partial.**
20. **Existing good semantics are preserved during migration.**

## 5. High-level architecture

~~~text
Human / AI / API Request
          |
          v
+---------------------------+
|  Public API / Request     |
|  normalization            |
+---------------------------+
          |
          v
+---------------------------+
| Repository + Snapshot     |
| Identity / Freeze         |
+---------------------------+
          |
          v
+---------------------------+
| Deterministic Planning    |
| - seed/intent resolution  |
| - scope planner           |
| - coverage universe       |
| - rule resolver           |
| - semantic units          |
+---------------------------+
          |
          v
+---------------------------+
| Evidence Providers        |
| static / git / runtime /  |
| test / external adapters  |
+---------------------------+
          |
          v
+---------------------------+
| Unified Evidence Graph    |
| + Evidence Ledger         |
+---------------------------+
          |
          +--------------------+
          |                    |
          v                    v
+------------------+  +----------------------+
| Deterministic    |  | Host ReasoningBridge |
| derivations      |  | proposed claims only |
+------------------+  +----------------------+
          \                    /
           \                  /
            v                v
          +--------------------+
          | Verification       |
          | + bounded expansion|
          +--------------------+
                    |
                    v
          +--------------------+
          | Coverage Finalize  |
          +--------------------+
                    |
                    v
          +--------------------+
          | AnalysisResult v1  |
          +--------------------+
             /       |       \
            v        v        v
        AI Renderer Human   JSON/API
                    Viewer
~~~

## 6. Deterministic authority vs host reasoning

### 6.1 CORE-owned deterministic authority

CORE is authoritative for:

- repository identity;
- snapshot identity;
- file enumeration;
- content hashing;
- parser/analyzer output identity;
- exact source anchors;
- symbol candidate enumeration;
- graph traversal;
- deterministic derivations;
- scope inclusion/exclusion accounting;
- coverage states;
- rule applicability and precedence;
- Semantic Analysis Unit validation;
- cache validity;
- runtime artifact integrity and identity gates;
- evidence provenance;
- evidence/counterevidence existence;
- negative-claim qualification;
- verification checks;
- session terminal state.

### 6.2 Host ReasoningBridge

A host may be asked to:

- rank competing hypotheses;
- explain a multi-hop interaction;
- propose a likely root cause;
- synthesize a change-impact narrative;
- identify plausible counterexamples to search;
- produce candidate claims from an Evidence Capsule.

The host returns **ProposedClaims**, not facts.

A host may not:

- create OBSERVED evidence;
- declare coverage COMPLETE;
- silently choose one ambiguous symbol as exact;
- upgrade correlated evidence into direct evidence;
- turn M5 into M6;
- turn a send into a receive;
- approve a NEGATIVE claim without the CORE gate;
- change repository/snapshot identity.

A provider-specific adapter implements `ReasoningBridge`; CORE itself stores no provider credentials and does not own provider billing.

## 7. Analysis modes and analysis policy

Mode and policy are orthogonal.

### 7.1 Modes

- `UNDERSTAND`: structure, responsibilities, major components, boundaries.
- `TRACE`: prove or disprove a path from A to B, including alternatives and gaps.
- `DIAGNOSE`: generate/test root-cause hypotheses with counterevidence.
- `IMPACT`: reverse dependency and propagation analysis for a proposed or actual change.
- `REVIEW`: diff-centered correctness/risk analysis.
- `AUDIT`: broad repository search for a property/risk/invariant.
- `RUNTIME`: convenience preset emphasizing static/runtime reconciliation.

Runtime is also a cross-cutting evidence source usable in every mode. `RUNTIME` is therefore a preset, not a separate storage model.

### 7.2 Policy

- `precision`: prefer fewer, strongly proven findings; default for REVIEW.
- `balanced`: balance precision and recall; default for TRACE/DIAGNOSE/UNDERSTAND/IMPACT.
- `exhaustive`: maximize search closure and explicit accounting; default for AUDIT.

The caller may override defaults.

## 8. Analysis pipeline

The normative pipeline is:

1. **Normalize Request**
   - validate schema;
   - normalize repository and requested refs;
   - resolve mode/policy/budget;
   - treat user-provided scope as seeds/bounds, not proof.

2. **Freeze Snapshot**
   - establish repository identity;
   - establish immutable snapshot identity;
   - hash runtime/external artifacts.

3. **Resolve Seeds / Intent**
   - requested path/symbol/diff/runtime object;
   - exact matches first;
   - retain candidate sets when ambiguous.

4. **Initialize Scope + Coverage Universe**
   - enumerate known candidates;
   - record closure policy;
   - create first Coverage Manifest state before analysis.

5. **Resolve Rules**
   - select only applicable rules;
   - record applied/rejected rules and versions.

6. **Build Semantic Analysis Units**
   - graph/contract-derived semantic units;
   - define primary targets, dependencies, supporting context, boundaries, and budget.

7. **Acquire Evidence**
   - static analyzers;
   - Git/history/diff;
   - runtime artifacts;
   - tests;
   - adapters;
   - optional external evidence.

8. **Build / Update Graph and Ledger**
   - topology in graph;
   - observations and claim relations in ledger.

9. **Reason**
   - deterministic derivations first;
   - optional ReasoningBridge for proposals.

10. **Verify**
    - provenance;
    - anchors;
    - paths;
    - counterevidence;
    - runtime/static consistency;
    - coverage;
    - negative-claim gate;
    - stale snapshot checks.
    - Verification may request bounded deterministic scope expansion.

11. **Finalize Coverage**
    - no known selected item remains silently pending;
    - compute COMPLETE/BOUNDED/PARTIAL/UNKNOWN and run terminal state.

12. **Render**
    - canonical AnalysisResult;
    - Human, AI, or JSON renderer.

## 9. Repository and snapshot identity

### 9.1 RepositoryIdentity

Repository storage keys must never be derived by lossy path replacement.

A repository identity contains, where available:

- VCS kind;
- normalized canonical remote identity;
- root/initial Git identity as fallback;
- object format;
- optional local-instance metadata.

Persistent keys use a cryptographic digest of the canonical identity.

### 9.2 SnapshotIdentity

Snapshot kinds:

- `COMMIT`
- `WORKSPACE`
- `ARCHIVE`
- `MULTI_REPO`

For `COMMIT`, commit SHA is mandatory.

For `WORKSPACE`, commit SHA alone is insufficient. CORE freezes:

- base/HEAD commit;
- index identity where relevant;
- a content-digest manifest for analyzed workspace files;
- deletion/untracked state.

For `MULTI_REPO`, every constituent repository has its own SnapshotIdentity. The workspace snapshot is the digest of the ordered constituent identities.

If a file changes after freeze, CORE either continues using the frozen bytes or returns `SNAPSHOT_CHANGED`. Mixing old and new file contents in one claim is forbidden.

## 10. Core data model

Representative shapes follow. Field naming may evolve compatibly inside v1, but semantics are frozen.

### 10.1 ClaimRecord

~~~text
ClaimRecord {
  id
  type:
    OBSERVED | DERIVED | INFERRED |
    HYPOTHESIS | NEGATIVE | UNKNOWN
  status:
    PROPOSED | VERIFIED | VERIFIED_WITH_LIMITS |
    REJECTED | UNRESOLVED

  subject
  predicate
  object_or_value

  evidence_links[]
  counterevidence_links[]
  dependency_claim_ids[]

  coverage_ref
  provenance_refs[]
  confidence {
    level: HIGH | MEDIUM | LOW
    rationale
  }

  derivation? {
    rule_id
    rule_version
  }

  verifier_results[]
}
~~~

Rules:

- `OBSERVED`: must be backed by acquired evidence that directly establishes the proposition.
- `DERIVED`: produced by a named deterministic rule over existing verified claims/evidence.
- `INFERRED`: reasoning-derived; must pass verification before final rendering as a conclusion.
- `HYPOTHESIS`: candidate explanation; never rendered as fact.
- `NEGATIVE`: verified absence/non-occurrence, subject to §13.
- `UNKNOWN`: explicitly unresolved proposition.

### 10.2 EvidenceRecord

~~~text
EvidenceRecord {
  id
  kind:
    SOURCE | STATIC_ANALYSIS | GIT | RUNTIME |
    TEST | EXTERNAL | USER

  observation
  provenance
  integrity_digest
  trust_class
  provider_id
  provider_version
  captured_at?
  payload_ref
}
~~~

Evidence is claim-independent. The strength of a particular evidence item is represented on the claim/evidence link:

~~~text
ClaimEvidenceLink {
  evidence_id
  role: SUPPORT | CONTRADICT | CONTEXT
  strength: DIRECT | INDIRECT | CORRELATED
  rationale?
}
~~~

This is necessary because one observation can be direct proof of one claim but only indirect support for another.

### 10.3 Provenance

~~~text
Provenance {
  repository_id
  snapshot_id
  provider_id
  provider_version

  artifact_id?
  artifact_digest?
  git_object_id?
  runtime_run_id?

  path?
  symbol_id?
  range? {
    start_line
    start_column?
    end_line
    end_column?
  }

  extraction_method
}
~~~

Missing range/symbol information stays missing. CORE never invents a line number.

## 11. Evidence Ledger vs Unified Evidence Graph

The two structures are complementary.

### Unified Evidence Graph

Answers:

- what is connected to what?
- what calls/reads/writes/dispatches/depends on what?
- what static and runtime entities correspond?
- what Git/runtime/external artifact is related?

### Evidence Ledger

Answers:

- what may we claim?
- what supports or contradicts it?
- is this observation, derivation, inference, hypothesis, negative, or unknown?
- what coverage qualifies the claim?
- what did verification decide?

Claims and evidence may appear as graph nodes for navigation, but the graph does not replace Ledger semantics.

## 12. Unified Evidence Graph v1

### 12.1 Base node kinds

- `repository`
- `snapshot`
- `file`
- `symbol`
- `class`
- `method`
- `field`
- `semantic_contract`
- `resource`
- `packet`
- `event`
- `command`
- `runtime_object`
- `variable`
- `test`
- `issue`
- `pull_request`
- `commit`
- `artifact`
- `external_document`
- `claim`
- `evidence`

Existing KNEEKURA shared Molang/animation/bone-name nodes map naturally to `semantic_contract` subtypes.

### 12.2 Base edge types

- `CONTAINS`
- `DEFINES`
- `CALLS`
- `READS`
- `WRITES`
- `IMPLEMENTS`
- `EXTENDS`
- `IMPORTS`
- `REFERENCES`
- `DEPENDS_ON`
- `SENDS`
- `RECEIVES`
- `DISPATCHES`
- `HANDLES`
- `TESTS`
- `CHANGED_BY`
- `OBSERVED_AT_RUNTIME`
- `SUPPORTED_BY`
- `CONTRADICTED_BY`
- `DERIVED_FROM`
- `CORRELATES_WITH`

Domain edges are allowed, but must be namespaced/versioned, for example `forge:REGISTERS_PACKET` or `ysm:READS_MOLANG`.

Every material edge carries origin/provenance/evidence references. Existing numeric `confidence` can remain for `kneekura.graph/v1` compatibility, but CORE v1 should prefer explicit resolution/strength semantics over false numeric precision.

## 13. Scope and Coverage Manifest

### 13.1 Scope item role

- `PRIMARY`
- `DEPENDENCY`
- `SUPPORTING_CONTEXT`
- `RUNTIME_ARTIFACT`

### 13.2 Scope item status

- `PENDING`
- `ANALYZED`
- `REUSED`
- `SKIPPED`
- `FAILED`
- `UNEXPLORED`

Role and status are separate. A supporting-context file is still ANALYZED or REUSED if CORE actually inspected it.

Every include/exclude/expand decision produces a `ScopeDecision` with:

- originating seed;
- causal graph edge or rule;
- planner/version;
- reason;
- budget/boundary cause.

### 13.3 Completeness

- `COMPLETE`: candidate universe is enumerable and every relevant item is terminally accounted under the selected closure policy.
- `BOUNDED`: complete inside an explicitly declared horizon; potential relevant material may exist outside it.
- `PARTIAL`: known relevant FAILED/UNEXPLORED items remain.
- `UNKNOWN`: CORE cannot reliably enumerate the candidate universe.

A percentage may be shown for convenience but is never the authority for a negative claim.

### 13.4 Negative-claim gate

A strong `NEGATIVE` claim is permitted only when all are true:

1. the searched predicate/property is supported by the active analyzer/provider;
2. the search universe is explicit;
3. the universe is enumerable;
4. all relevant items are ANALYZED/REUSED or deterministically proven irrelevant;
5. no relevant FAILED or UNEXPLORED item remains;
6. evidence belongs to the current snapshot;
7. verification found no counterevidence.

Otherwise the output must be equivalent to:

> Not found in the explored scope.

It must not be equivalent to:

> It does not exist.

## 14. Scope Planner

The Scope Planner is deterministic authority.

Seeds can come from:

- user paths;
- user symbols;
- a diff;
- issue/PR/commit;
- runtime object/artifact;
- graph node;
- prior claim/evidence ref.

Expansion follows mode-specific closure rules using graph relationships and semantic contracts. Depth/cost limits are explicit.

Ambiguous symbols are represented as candidate sets. The planner must not silently select the most similar name.

## 15. Semantic Analysis Units

A Semantic Analysis Unit (SAU) replaces file-centric “smart bundles”.

~~~text
SemanticAnalysisUnit {
  id
  purpose
  primary_targets[]
  dependency_items[]
  supporting_items[]
  boundary_edges[]
  matched_rule_ids[]
  budget
  deterministic_fingerprint
}
~~~

Example:

~~~text
UserService
  -> UserRepository
  -> mapper.xml
  -> schema
~~~

is one unit when deterministic graph/semantic evidence establishes that relationship.

An LLM may suggest a grouping only as an optimization hint. CORE validates every member against scope and graph evidence. If validation fails, CORE falls back to smaller deterministic units. LLM grouping is never a correctness gate.

## 16. Rule Resolver

Rules are versioned objects with:

- `rule_id`;
- version/hash;
- selectors;
- content/reference;
- precedence;
- trust/source.

Selectors may target:

- analysis mode;
- language;
- platform;
- path;
- node kind;
- edge kind;
- evidence kind;
- risk tag.

Default precedence:

1. explicit request rule;
2. repository rule;
3. workspace/global CORE rule;
4. built-in rule.

Only applicable rules enter the Evidence Capsule. Both applied and rejected candidates are auditable with reason/hash.

## 17. Evidence Providers

Providers acquire facts; they do not produce final prose.

Provider categories:

- source/file provider;
- parser/AST/symbol provider;
- generic graph provider;
- Git/diff/history provider;
- test provider;
- runtime trace provider;
- runtime pose/palette/network provider;
- external-analysis adapter;
- external-document provider.

Existing `src/analyzers/` and `src/adapters/` move toward this contract without losing domain semantics.

A provider declares:

- ID/version;
- supported input kinds;
- supported claims/properties;
- deterministic/non-deterministic nature;
- output evidence schema;
- dependency fingerprint;
- failure class.

## 18. Runtime evidence

Runtime evidence remains a separate fact source.

Required fields where applicable:

- artifact schema;
- artifact digest;
- run ID;
- repository/snapshot binding;
- entity/object identity;
- process/side identity;
- observed time/tick range;
- producer version.

Rules:

- identity mismatch cannot be silently joined;
- time proximity alone is insufficient identity;
- `send != receive`;
- `dispatch != execution`;
- M5 does not imply M6;
- weak state correlation stays `CORRELATED`;
- formal runtime application requires the designated direct evidence gate.

Static nodes and runtime observations may meet in the same graph while retaining distinct evidence IDs and origins.

## 19. Verification

Every important host-proposed claim passes verification before final rendering.

Verifier passes:

1. **Snapshot verifier**
   - all evidence matches frozen snapshot/artifact identity.

2. **Anchor verifier**
   - path/symbol/range/artifact exists and resolves.

3. **Path verifier**
   - claimed call/data/control path can be reconstructed from graph/evidence.

4. **Evidence-role verifier**
   - support/counter/context links have legitimate strength.

5. **Counterexample verifier**
   - searches plausible contradictory candidates according to mode/policy.

6. **Runtime/static verifier**
   - detects unsupported runtime leaps and identity mismatch.

7. **Coverage verifier**
   - checks claim is qualified by actual coverage.

8. **Negative verifier**
   - enforces §13.4.

9. **Staleness verifier**
   - rejects stale dependency fingerprints/snapshots.

Verification status:

- `VERIFIED`
- `VERIFIED_WITH_LIMITS`
- `REJECTED`
- `UNRESOLVED`

Verification may request bounded deterministic expansion. It may not quietly expand forever; budget/closure changes are recorded in Coverage.

## 20. Sessions and resume

An AnalysisSession is persisted as:

- append-only event log;
- materialized session state;
- terminal Coverage Manifest;
- content-addressed evidence references.

Session state includes:

- normalized request;
- repository/snapshot identity;
- engine fingerprint;
- rule fingerprints;
- scope decisions;
- SAUs;
- provider events;
- claims/evidence;
- verification;
- coverage;
- budget statistics.

### Same-snapshot resume

Reusable only when dependency/engine fingerprints remain compatible.

### Cross-snapshot continuation

Creates a child session linked to the parent. It reuses only content-addressed artifacts whose explicit dependencies remain valid.

A prior conclusion is never blanket-reused merely because the file path or session name matches.

## 21. Cache and invalidation

### C0 — immutable blobs

Keyed by source/runtime/external content digest.

### C1 — parse/static fact fragments

Key:

~~~text
content digest
+ analyzer/provider id/version
+ relevant analyzer config hash
~~~

### C2 — graph/index fragments

Keyed by snapshot plus provider/ontology dependencies, built incrementally from C1 fragments.

### C3 — scope / SAU planning

Keyed by snapshot, normalized seeds, planner version, mode/policy, relevant graph/rule dependencies.

### C4 — verified analysis result

Keyed by snapshot, normalized request, engine/rules/runtime dependencies, and reasoning dependency where applicable.

Invalidation is dependency-driven:

- source change invalidates affected parse/graph/claims;
- rule change does not invalidate raw parsing;
- renderer change does not invalidate analysis;
- new runtime artifact does not invalidate static parsing;
- host model change never invalidates deterministic evidence;
- changed provider semantics invalidate only dependent artifacts.

## 22. Exploration Ledger and token strategy

The first token strategy is: **do not rediscover or retransmit evidence unnecessarily**.

The Exploration Ledger records:

- scope items already acquired;
- provider requests;
- evidence IDs;
- fidelity/detail level;
- stale/valid state.

The ReasoningBridge receives an **Evidence Capsule**, not a repository dump.

A capsule may contain:

- normalized question/mode/policy;
- target symbols;
- minimal source excerpts with anchors;
- necessary graph path summaries;
- applicable rule fragments;
- evidence/counterevidence IDs;
- already verified facts by ID;
- coverage boundary;
- unknowns;
- requested validation.

Packing priority:

1. direct evidence;
2. counterevidence;
3. path closure needed for the question;
4. applicable rules;
5. supporting context;
6. explanatory prose.

Evidence itself is immutable and never lossily summarized. Old conversational narrative may be compressed because the verifier can rehydrate evidence by ID.

AI output profiles:

- `compact`
- `standard`
- `forensic`

Compact output may omit tutorial prose, but never the coverage/unknown qualifiers required to interpret a conclusion.

If required deterministic exploration cannot fit the scope/item budget, CORE
returns `PARTIAL / BUDGET_EXHAUSTED` with the relevant scope left explicitly
UNEXPLORED. Evidence Capsule packing pressure is a separate boundary: it
downgrades a run only when a ReasoningBridge was actually requested and cannot
be given its required capsule.

CORE may estimate tokens for packing/telemetry. It does not own provider pricing.

## 23. Public Plugin/API contract

The stable API is deliberately small.

### 23.1 Primary operation

~~~text
core.analyze(AnalysisRequest) -> AnalysisResult
~~~

Mode is a request field. Convenience plugin aliases such as `core.trace` or `core.diagnose` are thin wrappers around `core.analyze`, not separate engines.

### 23.2 Supporting operations

~~~text
core.expand(analysis_id, target, budget?) -> AnalysisDelta
core.get(ref) -> Claim | Evidence | GraphNode | Artifact
core.session.resume(session_id, target_snapshot?) -> SessionHandle
~~~

Internal planners, stores, analyzers, and provider details are not public API.

### 23.3 AnalysisRequest v1

~~~text
{
  schema
  repository
  snapshot_selector?
  mode
  question

  scope? {
    paths?
    symbols?
  }

  policy
  budget?
  runtime_artifacts?
  ruleset_overrides?
  output_profile?
}
~~~

No repository-write primitive exists.

### 23.4 ReasoningBridge

~~~text
ReasoningBridge.reason(ReasoningTask) -> ProposedClaimSet
~~~

The bridge is injected by the host/plugin. CORE does not configure the underlying provider.

## 24. AnalysisResult v1

Canonical result includes:

- analysis ID;
- session ID;
- repository identity;
- snapshot identity;
- terminal status;
- verified/limited/unresolved claims;
- evidence and counterevidence refs;
- relevant graph paths;
- affected symbols;
- rejected/negated hypotheses;
- coverage;
- unknowns;
- verifier records;
- warnings/failures;
- recommended validation.

Terminal run status:

- `COMPLETE`
- `PARTIAL`
- `FAILED`
- `SKIPPED`

Run status and individual claim verification status are separate.

## 25. Human Renderer

The Human Viewer consumes AnalysisResult + graph/evidence stores.

Required UX:

- architecture graph;
- symbol responsibility;
- callers/callees;
- semantic-contract crossings;
- static/runtime overlays;
- runtime observations;
- Git/issue/commit links;
- claim/evidence/counterevidence panel;
- exact source provenance;
- coverage/unexplored panel;
- unknown/failed analyzer visibility;
- lazy drill-down to avoid rendering entire graph.

Human tutorial prose is not sent to AI by default.

## 26. AI Renderer

The AI renderer is high-density and low-token.

Canonical semantic sections:

~~~text
STATUS
SNAPSHOT
ROOT_CAUSE / CLAIMS
EVIDENCE
COUNTEREVIDENCE
AFFECTED_SYMBOLS / PATHS
NEGATED_HYPOTHESES
UNKNOWN
COVERAGE
RECOMMENDED_VALIDATION
~~~

Evidence is referenced by stable IDs when already available to the host session.

The renderer may never omit a limitation that changes the epistemic meaning of a claim.

## 27. Security and trust boundaries

Trust classes include at least:

- `ENGINE_TRUSTED`
- `REPOSITORY_UNTRUSTED`
- `RUNTIME_MEASURED`
- `EXTERNAL_UNTRUSTED`
- `USER_ASSERTED`

Rules:

1. source comments, README text, logs, test output, and external pages are data;
2. prompt-like text inside evidence cannot change CORE/host instructions;
3. symlink/path traversal may not escape the frozen repository boundary;
4. secrets/credentials are redacted before Evidence Capsules;
5. external evidence keeps source URL/identity and digest where possible;
6. runtime artifacts are integrity-checked and identity-gated;
7. no target-repository writes;
8. no command execution merely because repository text requests it.

## 28. Failure semantics

Typed failures include:

- `INVALID_REQUEST`
- `SNAPSHOT_CHANGED`
- `SCOPE_UNRESOLVABLE`
- `ANALYZER_UNSUPPORTED`
- `ANALYZER_UNAVAILABLE`
- `PARSE_FAILED`
- `RULE_RESOLUTION_FAILED`
- `RUNTIME_IDENTITY_MISMATCH`
- `BUDGET_EXHAUSTED`
- `VERIFICATION_FAILED`
- `STALE_EVIDENCE`
- `TRUST_BOUNDARY_VIOLATION`
- `INTERNAL_INVARIANT`

Partial evidence remains available when safe. A run failure does not erase already valid observations.

`UNKNOWN`, `UNEXPLORED`, `UNOBSERVED`, `FAILED`, and `ABSENT` are different states and must never be rendered as synonyms.

## 29. YSM/KNEEKURA acceptance suite

Design baseline snapshots:

- KNEEKURA-CODE-LAB: `7a20ed6c4fdcb3ec39b072d5bb0d4c158820cb12`
- YSM decoded repo: `cdd903691c129ce565d4680ba83c00f2d04993d6`
- KNEEKURA-LAB: `15c270377d27fc06976d29fd285152a368ff9b58`
- reimu-mod: `ff4e3e03c3d1f44da4e1b722bb35b80209d4b8e2`

### AT-01 — final bone-matrix trace

Question:

> Where is the final YSM bone matrix generated?

Pass:

- candidate symbol(s) with exact source provenance;
- call/data path evidence where resolvable;
- related fields;
- runtime hook candidate(s);
- coverage and unexplored region;
- confidence rationale.

If exact resolution is impossible, explicit UNKNOWN/candidates is a pass. Fabricated certainty is a fail.

### AT-02 — M5 is not M6

Fixture has client command consumed (M5) without formal state application (M6).

Pass: no claim that YSM state applied.

### AT-03 — send is not receive

Fixture has send evidence without receive evidence.

Pass: receive stays unobserved; no packet-loss/client-failure claim.

### AT-04 — runtime identity mismatch

Use wrong run/entity/snapshot/artifact identity.

Pass: direct join rejected. Weak correlation may remain CORRELATED only.

### AT-05 — cross-repository semantic path

Trace Reimu/TLM -> packet/handler -> YSM semantic contract -> Molang/animation -> bone/runtime evidence.

Pass: path preserves repository/snapshot provenance and does not invent cross-repository Java calls.

### AT-06 — negative claim qualification

Hide or mark a relevant source item unexplored, then search for an absent variable/symbol.

Pass: no strong NEGATIVE until the search universe is closed.

### AT-07 — snapshot race

Modify a workspace file after freeze.

Pass: frozen bytes remain authoritative or analysis returns SNAPSHOT_CHANGED.

### AT-08 — same-snapshot resume

Repeat a query.

Pass: deterministic evidence is reused and host context transmission decreases without changing verified semantics.

### AT-09 — selective invalidation

Change one source file.

Pass: unrelated C1 parse facts remain reusable; dependent graph/claims are invalidated.

### AT-10 — obfuscation ambiguity

Provide multiple/decompiler-obscured candidates.

Pass: candidates remain explicit until resolved; name similarity is insufficient for exact identity.

### AT-11 — prompt injection in source data

Place instruction-like content in README/comments/logs.

Pass: no change to rules, tool authority, scope authority, or host instruction hierarchy.

### AT-12 — insufficient budget

Run an exhaustive request with an intentionally inadequate budget.

Pass: PARTIAL/BUDGET_EXHAUSTED with known unexplored items; no false completeness.

## 30. Migration plan

Migration is additive.

### Phase 0 — freeze the current substrate

- pin current `kneekura.graph/v1` fixtures;
- freeze runtime M0-M6 regressions;
- preserve current Viewer behavior.

### Phase 1 — identity and schema

- RepositoryIdentity;
- SnapshotIdentity;
- `core.evidence/v1`;
- `core.analysis-request/v1`;
- `core.analysis-result/v1`;
- compatibility adapter to/from current graph where meaningful.

### Phase 2 — Evidence Provider interface

- wrap existing scanners/analyzers/adapters;
- add provider/version/dependency fingerprints;
- make provenance first-class.

### Phase 3 — deterministic planning

- Scope Planner;
- Coverage Manifest;
- Rule Resolver;
- Semantic Analysis Units.

### Phase 4 — Ledger and verification

- Claim/Evidence records;
- deterministic derivations;
- counterevidence;
- independent verifier pipeline;
- negative-claim gate.

### Phase 5 — sessions/cache/incremental

- append-only sessions;
- materialized state;
- Exploration Ledger;
- C0-C4 caches;
- dependency invalidation;
- cross-snapshot child sessions.

### Phase 6 — API and AI integration

- `core.analyze`;
- `core.expand`;
- `core.get`;
- session resume;
- ReasoningBridge;
- AI renderer;
- Jolly Research Mailbox adapter may become one consumer rather than the canonical contract.

### Phase 7 — Human Viewer migration

- consume canonical AnalysisResult;
- graph/evidence/coverage panes;
- preserve current KNEEKURA-specific filters through domain extensions.

### Phase 8 — YSM-grade acceptance and plugin packaging

- execute AT-01..AT-12;
- publish stable plugin/API contract only after the suite passes.

## 31. OpenCodeReview influence

CORE adopts these concepts:

- deterministic file/scope filtering;
- deterministic rule resolution;
- explicit excluded-item reasons;
- immutable coverage manifest idea;
- terminal coverage partition;
- typed failures;
- manifest-certified resume;
- fail-fast budget guards;
- separation of deterministic engineering and host-agent reasoning;
- independent post-analysis verification as a distinct phase.

CORE deliberately changes these concepts:

1. **Semantic grouping**
   - OpenCodeReview currently uses an LLM best-effort grouping step.
   - CORE uses deterministic graph-derived SAUs; LLM grouping is hint-only.

2. **Coverage**
   - OpenCodeReview coverage is review-item centric.
   - CORE coverage applies to every mode and includes known unexplored/supporting/dependency/runtime scope.

3. **Verification**
   - OpenCodeReview primarily verifies/repositions review comments and filters provably incorrect comments.
   - CORE verifies generic claims, provenance, paths, counterevidence, runtime consistency, staleness, and negative claims.

4. **Sessions**
   - CORE uses cryptographic repository/snapshot identity and dependency-valid reuse across snapshot lineage.
   - It does not depend on lossy filesystem-path encoding or blanket conclusion reuse.

5. **Provider ownership**
   - CORE never requires its own LLM endpoint; a host ReasoningBridge is optional.

CORE rejects as global policy:

- review-only precision-first behavior;
- comment-centric output as the canonical data model;
- LLM-provider management as a CORE responsibility;
- auto-fix as a CORE responsibility;
- treating an LLM-created semantic group as an authoritative scope boundary.

## 32. Frozen decisions and extension points

The following are **frozen v1 decisions**:

- Repository Evidence Engine positioning;
- read-only target;
- snapshot-first evidence;
- Graph/Ledger separation;
- claim types;
- coverage semantics;
- negative-claim gate;
- deterministic SAU authority;
- provider-independent ReasoningBridge;
- independent verifier;
- small API centered on `core.analyze`;
- separate canonical result and renderers;
- content-addressed incremental reuse;
- runtime identity gating;
- YSM acceptance suite.

Extension points that may evolve without reopening architecture:

- exact parser implementation;
- storage backend;
- UI framework;
- graph database vs embedded store;
- domain semantic ontologies;
- additional Evidence Providers;
- host adapters;
- token estimator;
- non-Minecraft acceptance repositories.

A change to a frozen decision requires an architecture decision record explaining why its guarantees are preserved or superseded.
