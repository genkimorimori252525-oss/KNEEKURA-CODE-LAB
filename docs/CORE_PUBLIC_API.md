# CORE Public API / Reasoning Contract v1

Status: Milestone F implementation contract.

This document is additive to the frozen architecture and implementation plan.
It does not redefine `kneekura.graph/v1`, Evidence Ledger semantics, verifier
rules, or the Human Viewer milestone.

## Public surface

The public CORE surface is intentionally small.

~~~text
core.analyze(AnalysisRequest) -> AnalysisResult
core.expand(analysis_id, target, budget?) -> AnalysisDelta
core.get(ref) -> Claim | Evidence | GraphNode | Artifact
core.session.resume(session_id, target_snapshot?) -> SessionHandle
~~~

The implementation entry point is `src/core/api.mjs`.
`createCoreEngine()` exposes the retained-state operations.

Internal planners, providers, cache stores, Evidence Ledger mutation helpers,
and verifier internals are not public API.

## core.analyze

`core.analyze` orchestrates already-versioned CORE components in this order:

1. validate `core.analysis-request/v1`;
2. scan and freeze RepositoryIdentity / SnapshotIdentity;
3. resolve deterministic Scope;
4. resolve Rules;
5. build deterministic SAUs;
6. acquire or safely reuse provider evidence;
7. construct Evidence Ledger;
8. import and verify deterministic observed/derived Claims;
9. build Evidence Capsule;
10. optionally call an injected ReasoningBridge;
11. construct host-proposed Claims through the canonical Claim constructor;
12. run every accepted proposal through the deterministic verifier chain;
13. finalize `core.analysis-result/v1`.

Renderer decisions do not occur inside analysis.

A ReasoningBridge is optional. Analysis remains deterministic and usable
without one.

### Snapshot selector execution

`AnalysisRequest.snapshot_selector` is an execution constraint, not metadata.

For `{ kind: 'COMMIT', commit: '<full SHA>' }`, CORE:

1. resolves RepositoryIdentity from the original target repository;
2. verifies the exact requested Git object exists and is a commit;
3. reads the commit tree/blob objects through Git plumbing;
4. materializes only analyzable repository files into a CORE-owned temporary
   directory;
5. scans those bytes with the original RepositoryIdentity plus a canonical
   `COMMIT` SnapshotIdentity;
6. removes the temporary materialization after analysis.

CORE does not checkout, reset, create a worktree in, or otherwise mutate the
target repository to honor a COMMIT selector. Current HEAD and dirty working
tree state are therefore not substituted for the requested commit.

The CORE-owned temporary materialization root is also required to be outside
the target repository. A configured materialization location that resolves
inside the target is rejected with `TRUST_BOUNDARY_VIOLATION`.

`{ kind: 'WORKSPACE' }` keeps the existing frozen-workspace semantics,
including the post-freeze `SNAPSHOT_CHANGED` race check.

Selector kinds that the single-repository analyze path cannot execute are
rejected with `INVALID_REQUEST`; they are not silently ignored.

Evidence acquired from a COMMIT materialization keeps the original
RepositoryIdentity and the canonical COMMIT SnapshotIdentity in provenance.
The temporary filesystem path is not the repository identity.

## ReasoningBridge trust boundary

The interface is:

~~~text
ReasoningBridge.reason(ReasoningTask) -> ProposedClaimSet
~~~

CORE stores no provider credentials and does not know which model/provider a
host uses.

The host is proposal-only.

Allowed host proposal types:

- `INFERRED`
- `HYPOTHESIS`
- `NEGATIVE`
- `UNKNOWN`

A host cannot manufacture observed authority, deterministic derivation, search
authority, or canonical provenance. In particular, proposals cannot supply:

- canonical Claim ID;
- verification status;
- verifier results;
- verification records;
- canonical provenance refs;
- negative-search context/search universe.

Negative-search universe and provenance authority are constructed only by CORE
from deterministic scope/evidence state.

Proposal subjects must resolve to one exact node in the deterministic selected
candidate set. A symbol/node that exists elsewhere in the graph but is outside
Scope is rejected.

Proposal evidence IDs must already exist in the canonical Evidence Ledger and
must have been included in the exact Evidence Capsule given to the bridge.

A single ReasoningBridge result is bounded to 64 proposals. Excess proposals
are not verified or written to session Claim events; CORE reports a
`PROPOSAL_LIMIT_EXCEEDED` rejection summary instead.

NEGATIVE proposals remain subject to the Milestone D negative gate. A language
model cannot turn incomplete coverage into an authoritative absence claim.

### Optional host Evidence context cache

A ReasoningBridge adapter may optionally provide
`knownEvidenceIds({ analysis_id, snapshot_id, evidence_ids })`.

The adapter must return only stable Evidence IDs whose canonical EvidenceRecord
content is already retained by that host. CORE then omits those full records
from the host transmission and adds their IDs to
`capsule.reused_evidence_ids`.

Evidence not explicitly acknowledged remains transmitted as the canonical full
EvidenceRecord. Returning an ID that is not present in the current capsule is
rejected.

This is a transmission optimization only. The canonical Evidence Capsule used
for CORE proposal validation, Evidence Ledger, Claims, Coverage, and verifier
semantics is unchanged. AT-08 verifies that repeated same-snapshot analysis
reduces host transmission without semantic drift.

## Evidence Capsule

Schema:

~~~text
core.evidence-capsule/v1
~~~

Packing priority is:

1. direct support evidence;
2. counterevidence;
3. evidence anchored to selected Scope;
4. runtime context for runtime-oriented modes;
5. supporting context.

The capsule also carries:

- normalized question/mode/policy;
- selected target Scope;
- relevant graph paths;
- rules matched by selected SAUs;
- verified Claim IDs;
- Coverage boundary;
- UNKNOWN/unresolved constraints;
- source/provenance anchors;
- requested validation constraints.

Evidence IDs are deduplicated.

A packed EvidenceRecord is the canonical record, not an LLM-created
replacement summary.

Profiles:

- `compact`
- `standard`
- `forensic`

A request may further constrain capsule bytes/tokens through the existing
budget object.

If the capsule cannot fit its required envelope/evidence budget, CORE marks
`BUDGET_EXHAUSTED`, returns a PARTIAL AnalysisResult, and does not invoke the
ReasoningBridge with an incomplete reasoning context.

## AnalysisResult

`core.analysis-result/v1` remains the canonical result shared by all
consumers.

It contains machine-readable:

- repository/snapshot identity;
- terminal run status;
- Claims and verification status;
- EvidenceRecords and support/counterevidence refs;
- graph paths and affected symbols;
- Coverage;
- UNKNOWNs;
- verifier records;
- warnings/failures;
- recommended validation.

A run can be PARTIAL while an individual direct Claim remains
`VERIFIED_WITH_LIMITS`. Run status and Claim status are intentionally
separate.

Runtime stage boundaries are preserved. In particular, M5 client-command
consumption is not promoted into M6 formal YSM state application without the
required M6 runtime evidence.

## core.expand

Schema:

~~~text
core.analysis-delta/v1
~~~

Expansion accepts a retained analysis and a bounded target around:

- symbol;
- path;
- graph node;
- Claim;
- Evidence;
- runtime/artifact reference.

Expansion recomputes deterministic Scope/Rules/SAUs over the already frozen
graph. It does not silently switch repository snapshots.

When a persistent SessionStore is configured, expansion is recorded as a
same-snapshot child AnalysisSession with the original session as
`parent_session_id`. Coverage expansion metrics are recorded there.

The original terminal AnalysisResult is not rewritten in place. Expansion
returns an AnalysisDelta.

## core.get

Stable lookup supports:

- Claim ID;
- Evidence ID;
- GraphNode ID;
- artifact ID/digest/runtime run reference.

If a retained engine contains genuinely conflicting values for the same stable
ref across analyses, lookup fails as ambiguous instead of selecting one
silently.

## core.session.resume

Schema:

~~~text
core.session-handle/v1
~~~

Resume requires persistent CORE-owned session storage.

Same snapshot:

- replays the finalized parent AnalysisSession;
- restores and validates the persisted Exploration Ledger;
- treats only Evidence IDs present in non-stale restored acquisitions as
  available for reuse;
- checks current CORE engine compatibility;
- checks Coverage fingerprint;
- checks verifier versions;
- checks deterministic derivation rule versions;
- reports reusable/invalidated Evidence and Claims;
- reports whether persisted Exploration state is available.

If the Exploration Ledger is missing or cannot be validated, session event IDs
alone do not count as rehydratable Evidence; affected Evidence/Claims are
invalidated and `requires_reanalysis` becomes true.

Different snapshot:

- canonical provider results/Evidence are never automatically replayed;
- reusable Evidence starts empty;
- parent Evidence is explicitly invalidated;
- the handle is `CROSS_SNAPSHOT_REVALIDATION`;
- `requires_reanalysis` is true.

This preserves the Milestone E rule that cross-snapshot reuse must be
content/dependency proven and never path-only.

## AI renderer

`renderAnalysisForAI()` consumes AnalysisResult only.

Compact rendering may omit explanatory detail but never hides:

- Claim ID;
- Claim verification status;
- Coverage completeness;
- UNKNOWN entries;
- Evidence refs;
- recommended validation.

Forensic rendering additionally exposes provenance and verifier records.

Renderer prose is never written back into the Evidence Ledger or canonical
AnalysisResult.

## Jolly Research Mailbox adapter

`src/adapters/jolly-research-mailbox.mjs` is a consumer adapter.

Its schema is:

~~~text
jolly.research-mailbox-analysis/v1
~~~

It references `core.analysis-result/v1` as its source schema and preserves
canonical Claim IDs/status, Coverage, unknowns, warnings/failures, and
recommended validation.

Mailbox wording/shape is not a CORE canonical schema.

## Built-in JavaScript lexical evidence

CORE scans repository JavaScript modules with the deterministic
`builtin-javascript/lexical-v1` provider for these extensions:

- `.js`
- `.mjs`
- `.cjs`

The provider records repository file nodes, local/external module dependency
edges, class declarations, named function/function-binding declarations, and
explicit export names. Module type is classified only where the file extension
is authoritative: `.mjs` is ESM, `.cjs` is CommonJS, and plain `.js`
remains unclassified because its meaning can depend on package/tooling context.
Relative module specifiers are resolved only when a deterministic repository
file candidate exists. Package/builtin modules and unresolved relative imports
remain explicit unresolved external module references; CORE does not fabricate
repository ownership for them.

This is intentionally a lexical provider, not a JavaScript AST/type/runtime
engine. It does not claim full ECMAScript parsing, type inference, control-flow
resolution, call-target resolution, or runtime behavior. Comment text is masked
before matching, including comments inside template-literal expressions.
Template raw text is treated as data rather than executable code. Evidence
remains `REPOSITORY_UNTRUSTED` `STATIC_ANALYSIS` with the exact
repository/snapshot provenance.

COMMIT snapshot materialization uses the same analyzable-path predicate as the
workspace scanner, so JavaScript bytes used by a commit-pinned analysis come
from the requested Git tree rather than dirty workspace content.

## Target repository safety

No public API operation provides a repository-write primitive.

Session/cache storage remains CORE-owned and is rejected when configured
inside the target repository.

Runtime artifacts and source repositories are evidence inputs and are opened
read-only by the CORE analysis path.

## Milestone F non-goals

This milestone does not implement:

- Human Viewer canonical-result migration;
- DiagramProjection/UI layout;
- plugin contract freeze;
- YSM final acceptance suite;
- provider credentials;
- mandatory LLM execution.

Those remain later milestones.
