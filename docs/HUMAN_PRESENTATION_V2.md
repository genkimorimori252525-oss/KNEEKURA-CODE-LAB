# Human Presentation v2

Status: P0 complete. P1 Explorer Projection contract active.

Human Presentation v2 improves human exploration and presentation without changing the authority, schemas, or semantics of KNEEKURA CORE.

This document is the governing contract for Presentation work that follows CORE Human Viewer v1.

## 1. Authority

KNEEKURA CORE is the sole analysis authority.

Human Presentation v2 is a consumer of canonical CORE artifacts. It may organize, filter, lay out, summarize existing presentation metadata, and export selected canonical paths. It may not acquire evidence, verify Claims, reinterpret Coverage, or write presentation conclusions back into CORE.

The required direction is:

~~~
KNEEKURA CORE
    |
    +-- core.analysis-result/v1
    +-- kneekura.graph/v1
    +-- core.human-viewer-manifest/v1
    +-- Evidence refs
             |
             v
     Presentation Boundary
        |             |
        v             v
 Human Explorer   Diagram Export
~~~

The following reverse paths are forbidden:

~~~
Human Explorer -> CORE
Diagram IR -> CORE
Viewer state -> AnalysisResult
Viewer prose -> Evidence Ledger
Viewer grouping/layout -> Claim or semantic truth
~~~

## 2. Canonical inputs

Presentation code may consume canonical data through existing public or compatibility surfaces, including:

- `core.analysis-result/v1`
- `kneekura.graph/v1`
- `core.human-viewer-manifest/v1`
- canonical Evidence refs

Presentation-only state includes layout, zoom, selection, expanded/collapsed groups, theme, tour position, query text, filters, viewport, and presentation grouping.

Presentation-only state is never written back into canonical AnalysisResult, Evidence, Claim, Coverage, or repository graph semantics.

## 3. Frozen semantic invariants

Presentation code must preserve the v1 distinctions frozen by `CORE_SCHEMA_FREEZE_V1.md`.

In particular:

- M5 is not M6.
- packet send is not packet receive.
- CORRELATED is not OBSERVED.
- UNKNOWN is not ABSENT.
- UNEXPLORED is not ABSENT.
- FAILED is not ABSENT.
- PARTIAL is not COMPLETE.
- host proposal is not verified fact.
- static existence is not runtime observation.
- support Evidence is not counterevidence.

A visual simplification may hide detail at one zoom level, but it may not collapse these meanings.

## 4. Dependency direction

`src/core/**` must not depend on Presentation/UI implementation.

The automated P0 boundary audit rejects CORE imports of:

- React / React DOM
- React Flow / `@xyflow/react`
- ELK
- Dagre
- d3
- Archify implementation packages
- human-explorer packages
- `src/viewer/**`
- future `src/presentation/**`
- root `viewer/**`
- `packages/human-explorer/**`
- `third_party/**` Presentation code

Presentation may import stable CORE contracts. CORE may not import Presentation.

Deleting future Explorer/UI dependencies must leave scan, workspace, analyze, AI rendering, Mailbox integration, and CORE acceptance behavior operational.

## 5. Classic Viewer coexistence

The current dependency-free `viewer/` implementation is the Classic Viewer for the Human Presentation v2 migration.

P0 does not replace it and does not change the default viewer.

Existing compatibility surfaces remain authoritative during the migration:

~~~
node src/cli.mjs serve --graph dist/graph.json
node src/cli.mjs serve --bundle dist/viewer-bundle
~~~

The current loader fallback remains:

~~~
VIEWER_BUNDLE -> ANALYSIS_RESULT -> GRAPH_ONLY
~~~

A future Explorer CLI selector may be added only when an Explorer implementation exists and has its own acceptance coverage. Until then, Classic remains the fallback and current default. Default migration to Explorer is a later milestone, not a P0 action.

## 6. Failure isolation

Presentation failure is not Analysis failure.

A failed Explorer render, failed layout engine, failed diagram export, or missing optional UI dependency must not mutate or reinterpret the terminal status of an already-produced canonical AnalysisResult.

Future presentation/export status may be reported outside the frozen canonical result when needed. It must not overwrite `AnalysisResult.status`.

Legal example:

~~~
analysis: SUCCESS/COMPLETE
presentation: FAILED
export: NOT_RUN
~~~

The exact presentation-status transport is intentionally not frozen in P0.

## 7. Canonical digest gate

P0 establishes a non-regression gate over the complete canonical AnalysisResult.

For the same AnalysisResult object:

1. validate the canonical result;
2. compute a stable SHA-256 digest before Presentation projection;
3. run Presentation projection/bundle preparation;
4. compute the canonical digest again;
5. require the digests to match;
6. require the original canonical object to remain structurally unchanged.

The digest is a regression sentinel, not a new semantic identifier and not a replacement for SnapshotIdentity or Evidence IDs.

A Presentation PR that changes the canonical digest for the same input is rejected unless the CORE change is intentional, separately scoped, and reviewed under the CORE schema/architecture process.

## 8. Pinned Presentation Vendoring Exception

The repository-wide default remains adapter-first for analyzers and CORE. External analyzer engines are not vendored merely to implement Presentation.

Human Presentation v2 creates one narrow exception for Presentation/UI code when direct adaptation is materially better than a remote/output adapter.

The exception is called **Pinned Presentation Vendoring Exception**.

It permits pinned vendoring only when all of these conditions hold:

1. code is Presentation/UI only;
2. upstream commit SHA is fixed;
3. upstream license is compatible and preserved;
4. imported paths are recorded;
5. local modifications are recorded;
6. update procedure is documented;
7. vendored code is not imported by `src/core/**`;
8. vendored code does not become Claim/Evidence/Coverage authority;
9. update candidates pass Presentation tests, CORE regression, and the canonical digest gate before adoption.

Recommended provenance layout:

~~~
third_party/
  understand-anything/
    LICENSE
    UPSTREAM.md
    PATCHES.md
  archify/
    LICENSE
    UPSTREAM.md
    PATCHES.md
~~~

Each `UPSTREAM.md` must record at least:

- repository URL
- pinned upstream commit SHA
- license
- imported paths
- local modifications or patch location
- update procedure

Do not automatically follow an upstream `main` branch.

No third-party code is vendored by P0 itself. P0 only defines the rule that later focused PRs must satisfy.

## 9. Understand Anything and Archify roles

Human Presentation v2 keeps the three responsibilities separate:

- KNEEKURA: truth, evidence, analysis, verification.
- Understand Anything-inspired Explorer: navigation, drill-down, search, human comprehension.
- Archify-inspired export: communication and presentation of a selected canonical path.

Neither external project is an alternate analysis authority.

Explorer grouping is presentation metadata. Diagram selection is a curated projection. Neither can create a canonical edge or promote a Claim.

## 10. Security boundary

Repository content and runtime artifacts are untrusted data.

Labels, summaries, descriptions, source text, Evidence text, Markdown, and runtime payloads must be escaped/sanitized for their target rendering context. They must never execute because they look like HTML, JavaScript, Markdown instructions, or agent instructions.

Presentation code inherits the CORE trust-boundary rule: repository text cannot acquire instruction authority.

## 11. P0 acceptance

P0 is complete only when all of the following are true:

- this Human Presentation v2 contract exists;
- automated CORE -> Presentation dependency guard passes;
- the canonical AnalysisResult digest gate passes;
- Classic Viewer fallback/coexistence remains available;
- Pinned Presentation Vendoring Exception is documented;
- focused P0 acceptance tests pass;
- existing CORE acceptance and repository regression tests remain green;
- no frozen CORE schema or analyzer semantics are changed by the P0 diff.

P0 intentionally does not implement React, React Flow, ELK, Dagre, Understand Anything UI code, Archify code, semantic zoom, guided tours, or diagram export.

Those belong to later focused milestones after this boundary is proven.

## 12. Change discipline

Presentation work should remain independently revertible.

If a future Presentation feature appears to require a CORE schema change, first ask whether the need can be represented as presentation metadata or a traceable projection. If yes, keep it outside CORE.

If a genuine CORE change is required, separate it from the Presentation PR and follow the frozen v1 compatibility rules. Breaking semantics require a new schema version and migration path.

The safety priority is:

~~~
canonical truth and evidence
    > semantic fidelity
    > compatibility
    > presentation features
~~~

## 13. P1 — Explorer Projection contract

P1 introduces a Presentation-only projection with schema `kneekura.explorer-projection/v1`.

The projection is an **immutable-style consumer snapshot**: it clones the canonical graph and AnalysisResult and adds parallel Explorer metadata. It does not translate canonical records into a replacement semantic model.

~~~
{
  schema: "kneekura.explorer-projection/v1",
  source: {
    graph_schema,
    analysis_result_schema,
    analysis_id,
    session_id,
    snapshot_id,
    analysis_result_digest
  },
  canonical: {
    graph,   // structured clone of kneekura.graph/v1
    result   // structured clone of core.analysis-result/v1
  },
  presentation: {
    nodes,   // one entry per canonical node
    edges,   // one entry per canonical edge
    claims,  // exact status/type/link metadata + canonical index
    coverage // exact role/status + canonical index
  }
}
~~~

### P1 identity rules

For every canonical graph node there is exactly one Presentation node metadata entry and vice versa. `node_id` is the canonical node ID and `canonical_kind` is the canonical node kind verbatim.

For every canonical graph edge there is exactly one Presentation edge metadata entry and vice versa. `edge_id`, `from_node_id`, `to_node_id`, and `canonical_type` are copied verbatim from the canonical edge.

P1 does not create group/container nodes inside the canonical graph and does not create inferred connector edges. Later UI grouping must live outside `canonical.graph.nodes` / `canonical.graph.edges`.

### Display family is not semantic authority

P1 may attach a coarse `display_family` to node metadata for future styling/navigation. For example, a `molang_variable` may receive `display_family: "semantic"`.

This is Presentation metadata only. The canonical kind remains `molang_variable`; downstream code must never use `display_family` as a substitute for the canonical kind, Claim authority, Evidence authority, or edge semantics.

### Claim / Evidence / Coverage rules

Claim metadata keeps these fields verbatim when present:

- `type`
- `status`
- `evidence_links`
- `counterevidence_links`
- `coverage_ref`

Coverage metadata keeps `role` and `status` verbatim. Unknowns, warnings, failures, Evidence bodies/refs, graph paths, affected symbols, and all other canonical fields remain available in `canonical.result` without rewriting.

Therefore P1 cannot reinterpret:

- `UNKNOWN` as `ABSENT`
- `FAILED` as `ABSENT`
- `UNEXPLORED` as `ABSENT`
- `CORRELATED` as `OBSERVED`
- packet send as receive
- M5 as M6
- static edges as runtime observations
- counterevidence as support Evidence

### Canonical input identity correlation

When a canonical Graph carries `meta.repository.repository_id` and/or `meta.snapshot.snapshot_id`, P1 must compare those values with the AnalysisResult repository/snapshot identity before creating the projection.

- matching identities are recorded as `MATCH`
- unavailable Graph identity metadata is recorded as `UNAVAILABLE`
- an explicit repository or snapshot mismatch fails the Presentation projection closed

A mismatch is a Presentation failure only. It must not alter the already-produced AnalysisResult or turn Analysis success into Analysis failure.

This gate prevents a stale/different Graph from being silently paired with a valid AnalysisResult.

### Determinism and mutation

For the same canonical inputs, P1 output must be deterministic.

Creating a projection must leave both input objects structurally unchanged. The canonical AnalysisResult digest before and after projection must match exactly.

### P1 non-goals

P1 does not implement:

- React / React Flow
- ELK / Dagre layout
- search UI
- layers / containers / drill-down UI
- semantic zoom
- Guided Tours
- Archify projection/export
- a new default Viewer

Those remain later milestones.

### P1 acceptance subset

P1 must cover the following Presentation acceptance invariants before merge:

- PT-01 canonical node IDs preserved one-to-one
- PT-02 canonical edge IDs preserved one-to-one
- PT-03 edge semantics/type and endpoint identity preserved
- PT-04 UNKNOWN semantics preserved
- PT-05 PARTIAL/FAILED/UNEXPLORED semantics preserved
- PT-06 static/runtime metadata preserved without promotion
- PT-07 packet send/receive remain distinct
- PT-08 M5/M6 remain distinct
- PT-09 Evidence links/refs preserved
- PT-10 Counterevidence links preserved separately
- PT-11 KNEEKURA-specific node kinds preserved
- PT-12 every Presentation graph item is source-traceable

