# CORE Evidence Providers v1

Status: PR B / Milestone B compatibility contract.

## Boundary

This milestone introduces the Evidence Provider and provenance bridge without introducing the Evidence Ledger, Scope/Coverage planner, ReasoningBridge, cache, Viewer rewrite, or plugin API.

Existing analyzers and adapters remain the implementation of current KNEEKURA semantics. Provider wrappers call those implementations rather than replacing them.

## Provider contract

Each provider exposes:

- provider ID and version;
- capabilities;
- dependencyFingerprint(context);
- acquire(context, unit).

Each acquisition returns an internal ProviderResult containing:

- canonical EvidenceRecords;
- graph fragments;
- diagnostics;
- typed provider failures;
- unresolved references;
- provider metrics;
- dependency fingerprint.

## Additive graph metadata

Single-repository and workspace outputs remain kneekura.graph/v1.

Provider data is additive under graph metadata:

- meta.providers
- meta.providerResults
- meta.evidence containing core.evidence/v1 records
- meta.providerFailures
- meta.unresolvedReferences

Existing graph evidence strings and all current node/edge meanings remain compatibility data.

Workspace output carries the canonical evidence produced by each constituent repository. Each EvidenceRecord keeps its constituent repository and snapshot provenance; the MULTI_REPO snapshot does not overwrite that provenance.

## Provenance

Every canonical EvidenceRecord contains repository ID, snapshot ID, provider ID/version, extraction method, integrity digest, and trust class.

Repository sources use a frozen repository-relative path when known.

Runtime and imported artifacts use artifact identity and SHA-256 digest when readable. Runtime trace/network/pose/palette evidence records the trace run identity when it is available and accepted.

Unknown symbol or source ranges remain absent. CORE does not insert zero as a substitute for an unknown location.

## Unresolved semantics

Unresolved is explicit and is not converted into absence.

Java lexical imports that are not resolved to a repository symbol remain external graph symbols and are marked resolution=UNRESOLVED. The provider result also records the unresolved import.

A runtime network channel with no static match remains a runtime_network_channel with unresolvedStaticChannel=true. The provider does not fabricate a static network_channel node.

## Typed failures

Provider exceptions and explicit companion rejection diagnostics become typed failures. PR B uses the architecture-defined provider/runtime subset:

- ANALYZER_UNSUPPORTED
- ANALYZER_UNAVAILABLE
- PARSE_FAILED
- RUNTIME_IDENTITY_MISMATCH
- TRUST_BOUNDARY_VIOLATION
- INTERNAL_INVARIANT

A failure does not erase evidence safely acquired by other providers.

## Compatibility and non-goals

- existing analyzer names remain available;
- existing node/edge semantics are not renamed;
- send still does not imply receive;
- runtime observations stay distinct from static facts;
- target repositories stay read-only;
- normal tests require no Minecraft process;
- Evidence Ledger, verification, scope coverage, cache and host reasoning remain later milestones.
