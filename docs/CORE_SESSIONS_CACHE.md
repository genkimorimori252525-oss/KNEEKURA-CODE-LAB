# CORE Sessions, Cache, and Exploration Ledger v1

Status: Milestone E compatibility contract.

## Boundary

Milestone E adds durable reuse and resumability on top of Milestones A-D.

It includes:

- append-only AnalysisSession event logs
- materialized session replay
- C0-C4 cache identity and dependency fingerprints
- persistent CORE-owned cache storage
- Exploration Ledger provider-result reuse
- persisted Exploration Ledger resume
- cross-snapshot continuation planning
- stale Claim invalidation
- provider/cache/token-savings metrics fields

It does not add the public `core.analyze` API, ReasoningBridge, Evidence Capsule, AI renderer, Human Viewer migration, or plugin contract. Those remain Milestones F-H.

`kneekura.graph/v1` semantics remain unchanged.

## CORE-owned storage

All persistent session/cache state belongs under a caller-supplied CORE storage root.

If the storage root is inside the analyzed target repository, CORE refuses the operation.

Target repositories remain read-only.

Materialized session state and Exploration Ledger files may be rewritten inside CORE-owned storage. The authoritative session history remains the append-only event log.

## AnalysisSession event log

Session events use `core.session-event/v1`.

Supported lifecycle events include:

- SESSION_STARTED
- SNAPSHOT_FROZEN
- SCOPE_DECISION
- PROVIDER_STARTED
- PROVIDER_COMPLETED
- PROVIDER_FAILED
- EVIDENCE_STORED
- EVIDENCE_REUSED
- CLAIM_PROPOSED
- CLAIM_VERIFIED
- CLAIM_REJECTED
- COVERAGE_CHANGED
- METRICS_UPDATED
- SESSION_FINALIZED

Each event contains:

- monotonic sequence number
- previous event digest
- canonical event digest
- timestamp
- typed payload

The hash chain detects tampering or reordering.

A session is sealed after `SESSION_FINALIZED`; later event appends are rejected.

Replay rebuilds `core.analysis-session-state/v1`, including:

- session identity
- parent/target snapshot identity
- normalized request
- engine/rule fingerprints
- scope decisions
- provider lifecycle events
- evidence/reuse sets
- claims
- Coverage Manifest
- metrics
- finalization state

Terminal coverage and claims must be reproducible from the event log without renderer prose.

## Cache tiers

Cache artifacts use `core.cache-artifact/v1`.

### C0 — immutable blobs

C0 is content-addressed by SHA-256.

Identical bytes resolve to the same immutable blob key.

### C1 — parse/static fact fragments

C1 keys bind:

- source content digest
- provider/analyzer ID
- provider/analyzer version
- relevant analyzer config fingerprint
- explicit dependency set

A path name is not part of the authority for reuse.

Changing one file therefore changes that file's C1 key while unrelated file-content keys remain reusable.

### C2 — graph/index fragments

C2 keys bind:

- snapshot ID
- provider dependencies
- ontology fingerprint

### C3 — scope/SAU planning

C3 keys bind:

- snapshot ID
- normalized seeds
- planner version
- mode/policy
- graph dependency
- rule dependency

### C4 — verified analysis result

C4 keys bind:

- snapshot ID
- normalized request
- engine fingerprint
- rule dependencies
- runtime dependencies
- reasoning dependency when applicable

C4 must not be treated as reusable until all declared dependencies are valid.

## Dependency fingerprints

Dependency lists are canonicalized and deduplicated before hashing.

Examples:

- content dependency
- provider ID/version
- analyzer config
- graph/ontology fingerprint
- Coverage fingerprint
- EvidenceRecord IDs
- verifier versions
- rule versions
- runtime artifact IDs/digests

A cache hit requires the stored dependency fingerprint to match the caller's expected dependencies.

A provider-version or dependency change must invalidate only dependent artifacts, not unrelated C0/C1 content.

## Exploration Ledger

Exploration Ledger schema:

`core.exploration-ledger/v1`

Before acquiring provider evidence, CORE may query the ledger with:

- provider ID/version
- dependency fingerprint
- target snapshot
- minimum required fidelity

Reuse is allowed only when:

- the acquisition is not stale
- provider identity/version match
- dependency fingerprint matches
- snapshot compatibility holds
- cached fidelity is at least the requested fidelity

If no suitable entry exists, CORE reacquires through the original provider.

On same-snapshot reuse, the stored provider result restores:

- graph fragment nodes
- graph fragment edges
- diagnostics
- canonical EvidenceRecords
- provider metadata/results
- provider return value required by downstream analyzers

This means downstream Forge/Minecraft analyzers receive the same Java analysis value without re-running the Java analyzer.

The ordinary scan path is unchanged unless an Exploration Ledger is explicitly supplied.

## Persistent resume

An Exploration Ledger can be serialized into CORE-owned session storage and restored later.

A reload followed by the same frozen snapshot can reuse deterministic provider results without provider reacquisition.

This is the durable form of same-snapshot resume; it does not depend on process memory surviving.

## Cross-snapshot continuation

Continuation uses:

`core.session-continuation/v1`

It records:

- parent_session_id
- parent_snapshot_id
- target_snapshot_id
- reused_evidence_ids
- invalidated_evidence_ids
- reusable_claim_ids
- invalidated_claims with machine reasons

Cross-snapshot reuse must never be authorized solely by a matching path.

Content/artifact identity and explicit dependencies are required.

Exploration Ledger provider-result replay is intentionally same-snapshot only. A caller request to directly replay a cached provider result across snapshots is rejected. Cross-snapshot reuse occurs at the content-addressed cache/artifact layer (for example C1); canonical EvidenceRecords and Claims are re-established/revalidated for the target snapshot rather than inheriting stale snapshot provenance.

## Claim reuse safety

A prior Claim is reusable only after its dependencies are revalidated.

Checks include:

- all support/counterevidence IDs still available
- current Coverage fingerprint
- verifier IDs/versions
- derivation rule IDs/versions
- session engine fingerprint
- session rule fingerprints

Missing compatibility information is treated as unverified, not compatible.

Because Coverage fingerprints include snapshot identity, cross-snapshot Claims normally require re-verification even when lower-level content artifacts are safely reusable.

This preserves the separation:

- reusable parse/static artifacts can survive a small source change
- stale conclusions do not survive merely because paths or names match

## Metrics

Session state records:

- provider_acquisitions
- provider_reuse_count
- evidence_ids_sent_to_reasoning_bridge
- raw_excerpt_bytes_packed
- raw_excerpt_tokens_packed
- cache_hits
- cache_misses
- invalidation_reasons
- coverage_expansion_count

Milestone E actively records provider acquisition/reuse and cache hit/miss events. Continuation planning also emits machine-counted invalidation reasons suitable for a METRICS_UPDATED session event.

ReasoningBridge and Evidence Capsule counters are reserved now and become active in Milestone F without changing the session metrics schema.

Metrics are operational evidence of reuse/token savings; they do not depend on provider pricing.

## Milestone E acceptance

Milestone E is implementation-complete only when regressions demonstrate:

- same-snapshot rerun reuses deterministic provider results
- persisted Exploration Ledger reload also reuses same-snapshot provider results
- one-file content change leaves unrelated C1 entries reusable
- insufficient-fidelity entries are not reused
- stale dependent Claims are invalidated
- engine/rule compatibility must be proven for continuation
- path-only cross-snapshot evidence reuse is rejected
- child session state preserves parent/target/reused/invalidated identities
- finalized sessions reject further event appends
- concurrent in-process session appends remain serialized into one valid event hash chain
- cross-snapshot provider-result replay is rejected
- continuation invalidation reasons are machine-counted
- session event-chain tampering is detected
- session replay reproduces terminal coverage and claims
- CORE cache/session storage cannot be placed inside the target repository
- all existing scan/workspace/runtime/pose/network/palette regressions remain green

## Non-goals

Milestone E does not:

- invoke an LLM
- define provider credentials
- expose `core.analyze`
- create AI or human renderers
- change Viewer behavior
- weaken Evidence/Claim verification
- reuse Claims on path equality
- write session/cache state into the analyzed repository
