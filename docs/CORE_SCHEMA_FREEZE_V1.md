# CORE v1 Schema Freeze

Status: frozen after Milestone H acceptance.

Freeze gate:

- AT-01 through AT-12: PASS
- first complete acceptance run: CI #503
- test result: 197/197 PASS

The following public schemas are now frozen v1 contracts:

- `core.analysis-request/v1`
- `core.analysis-result/v1`

This freeze does not mean implementation internals can never change. It means
a consumer written against the v1 contract must not silently receive a
breaking reinterpretation.

## Request contract

`core.analysis-request/v1` remains the input to `core.analyze`.

Frozen semantic requirements include:

- explicit repository identity/root
- explicit analysis mode
- explicit question
- explicit policy
- deterministic Scope authority
- bounded budget semantics
- optional runtime artifacts
- optional rule overrides
- output profile selection

Repository/source text cannot create new request authority.

A future incompatible request shape requires a new schema version.

## Result contract

`core.analysis-result/v1` remains the canonical output shared by:

- API consumers
- ReasoningBridge verification flow
- AI renderer
- Human Viewer
- Jolly Research Mailbox adapter
- plugin adapter

Frozen semantic requirements include:

- RepositoryIdentity and SnapshotIdentity
- terminal run status
- Coverage Manifest
- Claim verification status
- Evidence and counterevidence refs
- graph paths / affected symbols
- UNKNOWNs
- verifier records
- warnings / failures
- recommended validation

The optional inline `evidence` field may be externalized by the Human Viewer
bundle because Evidence is still addressed by canonical stable IDs.

## Frozen distinctions

v1 must preserve these distinctions:

- M5 is not M6
- packet send is not packet receive
- CORRELATED is not OBSERVED
- UNKNOWN is not ABSENT
- UNEXPLORED is not ABSENT
- FAILED is not ABSENT
- PARTIAL is not COMPLETE
- a host proposal is not a verified fact
- a path match is not sufficient negative-search authority

## Compatibility rule

Backward-compatible additive metadata may be introduced only when existing v1
consumers remain valid and the frozen semantics above do not change.

Breaking changes require a new schema version and an explicit migration path.

## Acceptance authority

The freeze is backed by `test/core-acceptance.test.mjs`.

AT-01 uses the curated oracle:

`fixtures/core/acceptance/at-01-bone-matrix-oracle.json`

The YSM oracle deliberately records the final JVM-visible handoff as a native
boundary and leaves the exact native per-bone generation point UNKNOWN. This
is part of the v1 anti-fabrication contract.
