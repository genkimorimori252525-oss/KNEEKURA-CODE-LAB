# CORE Deterministic Planning v1

Status: PR C / Milestone C compatibility contract.

## Boundary

Milestone C adds deterministic planning only:

- Scope Planner
- Coverage Manifest lifecycle
- Rule Resolver
- Semantic Analysis Units (SAUs)

It does not add Claims, the Evidence Ledger, verification, negative-claim authorization, sessions/cache, ReasoningBridge, renderers, Viewer migration, or plugin contracts.

## Scope Planner

The planner accepts exact seeds for:

- repository paths
- symbols
- diff files
- graph node IDs
- runtime artifact/entity/run references

Exact matches win. Ambiguous symbols remain explicit candidate sets. No fuzzy or LLM-selected winner is allowed.

Every include/expand/exclude operation writes a ScopeDecision containing the originating seed, planner/version, reason, cause, depth, and causal graph edge when applicable.

Graph expansion is deterministic, confidence-gated, and excludes correlated-only relationships. IMPACT expands in reverse dependency direction; TRACE/RUNTIME prefer flow/runtime relationships.

Known items outside an explicit depth horizon remain UNEXPLORED with reason code DEPTH_HORIZON. Known items excluded by an item budget use BUDGET_EXHAUSTED instead.

## Coverage

Coverage roles and statuses remain those frozen in the architecture.

Planning creates a Coverage Manifest before terminal accounting. Selected items start PENDING; known boundary items can already be UNEXPLORED with an explicit reason.

The finalizer has a backstop: a PENDING item cannot survive terminal coverage.

Completeness is computed as:

- UNKNOWN when the candidate universe is not enumerable
- PARTIAL when a relevant provider failure or non-depth UNEXPLORED item remains
- BOUNDED when the only gap is an explicit depth horizon
- COMPLETE when the enumerable selected universe is terminally accounted

This milestone still does not authorize strong NEGATIVE claims. That gate remains Milestone D.

## Rule Resolver

Rules are versioned and content-hashed. Selectors can match mode, language, platform, path, node kind, edge kind, evidence kind, and risk tag.

Precedence is deterministic:

1. explicit request
2. repository
3. workspace/global CORE
4. built-in

Applied and rejected rules are both retained with reasons and hashes. A higher-precedence rule with the same rule_id shadows lower-precedence definitions.

## Semantic Analysis Units

SAUs are formed only from deterministic strong graph/domain relationships.

Examples include:

- declaration/method ownership
- caller/reference relationships when available
- implementation/inheritance
- packet registration/send/handler
- Molang/animation/bone contracts
- workspace semantic boundary edges
- semantic Understand Anything edges, excluding broad project/layer/tour containment

Correlated-only edges are never authoritative grouping edges.

Large connected units are split deterministically by item budget while keeping every selected item assigned exactly once. Cross-unit relationships remain visible as boundary edges.

## Compatibility

- kneekura.graph/v1 remains unchanged
- existing scan/workspace CLI behavior is unchanged
- current Viewer remains usable
- no LLM is required
- no analyzed repository writes are introduced
- existing provider/evidence provenance remains authoritative
