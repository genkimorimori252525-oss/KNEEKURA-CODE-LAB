# CORE v1 Compatibility Notes

Status: PR A / Milestone A compatibility contract.

## Existing graph contract

PR A preserves the existing `kneekura.graph/v1` schema and existing node/edge semantics. Repository and snapshot identity are added as graph metadata only.

No repository node identity fields, analyzer semantics, boundary edge semantics, or existing `meta.workspace` fields are renamed or reinterpreted.

## Single-repository scans

A successful `scanRepository` result adds:

- `meta.repository`: `core.repository-identity/v1`
- `meta.snapshot`: `core.snapshot-identity/v1` with kind `WORKSPACE`

The live workspace snapshot is captured by `scanRepository`; callers cannot inject an arbitrary snapshot identity to bypass the freeze check.

Before returning a successful graph, a WORKSPACE snapshot is captured again. If the repository contents changed after the initial freeze, the scan fails with `SNAPSHOT_CHANGED` instead of returning a mixed-state graph.

## Workspace scans

The existing `meta.workspace` object remains unchanged.

Workspace merge additionally exposes:

- `meta.repositories[]`, with each repository name plus its repository/snapshot identity when available
- `meta.snapshot`, a `MULTI_REPO` SnapshotIdentity when every constituent graph has snapshot metadata

Handcrafted or legacy graphs without identity metadata remain mergeable. If every constituent snapshot is not available, no workspace-level `MULTI_REPO` snapshot is synthesized.

## PR A boundary

PR A does not convert analyzers to frozen-byte streams. It guarantees that a changed live workspace is not returned as a successful mixed-state scan; full frozen-byte plumbing remains a later migration.

Evidence Ledger migration, ReasoningBridge, Runtime Validation Framework, claim/cache migration, Viewer rewrite, plugin cleanup/distribution, and other later CORE stages are out of scope.
