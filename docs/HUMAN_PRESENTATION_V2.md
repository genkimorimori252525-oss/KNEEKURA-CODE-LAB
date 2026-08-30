# Human Presentation v2

Status: P0/P1/P2/P3 complete. P4 semantic visualization contract active.

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



## 14. P2 — Explorer Shell contract

P2 adds the first interactive Human Explorer shell on top of `kneekura.explorer-projection/v1`. It is an **opt-in Presentation application**, not a replacement analysis model and not the default Viewer.

### P2 stack and dependency boundary

The shell may use Presentation-only UI/runtime dependencies:

- React
- React DOM
- React Flow / `@xyflow/react`
- ELK-compatible automatic layout

Those dependencies must stay outside `src/core/**`. Removing the Explorer package must leave CORE analysis, Mailbox/AI surfaces, and the Classic Viewer operational.

The P2 shell consumes an already-created Explorer Projection. It does not call analyzers, acquire Evidence, verify Claims, or write UI state back into canonical data.

### P2 UI-only state

The following are Presentation state only:

- viewport position and zoom
- selected node
- search query and matched-node focus
- fit-view requests
- layout positions
- minimap state
- transient UI errors

None of these may change canonical node IDs, edge IDs, node kinds, edge types, Claim status, Evidence links, Counterevidence, Coverage, Unknowns, or AnalysisResult status.

### P2 traceability rules

Every React Flow node must use the canonical `node_id` as its React Flow `id`.

Every React Flow edge must use the canonical `edge_id` as its React Flow `id`, with `source` and `target` copied from the canonical endpoints and `canonical_type` retained in edge data.

Layout is geometry only. ELK output may assign `x`/`y` coordinates but may not synthesize canonical nodes or edges, merge identities, reverse an edge, or reinterpret its type.

A failed layout must fail the Explorer rendering path without mutating `projection.canonical` or the original AnalysisResult.

### P2 baseline interaction

P2 provides only the shell-level interactions needed to establish the Explorer runtime:

- pan and zoom
- fit view
- MiniMap
- text search over inert Presentation labels/IDs/kinds
- focus the selected/search-matched canonical node
- node selection
- a detail surface that exposes source-traceable canonical identity and generic Presentation metadata

P2 does not define architecture layers, hierarchy containers, semantic zoom, guided tours, or specialized KNEEKURA domain rendering.

### P2 security rule

Repository-controlled labels, keys, IDs, predicates, and other displayed text are untrusted data.

The React shell must render them as ordinary text values. It must not use `dangerouslySetInnerHTML`, execute Markdown/HTML from repository content, evaluate strings, create script URLs from repository data, or treat repository prose as instructions.

Search normalization may compare text but may not reinterpret it as code.

### Classic Viewer coexistence

The existing `node src/cli.mjs serve ...` path remains the Classic Viewer and remains unchanged in meaning.

Explorer build/projection/serve commands must be explicit opt-in commands. P2 must not make Explorer the default Viewer and must not remove the Classic fallback.

### P2 failure isolation

Explorer errors are Presentation errors only.

A missing Explorer build, failed fetch, failed React render, or failed layout must not overwrite an existing `core.analysis-result/v1` status. The canonical result digest must remain unchanged for the same input.

### P2 deferrals

The following remain outside P2:

- P3: architecture Layers, containers, drill-down and hierarchical exploration
- P4: KNEEKURA-specific semantic visualization
- later: Evidence inspector UX, semantic zoom, Guided Tours, Archify adapter/export, and default-viewer migration

### P2 acceptance subset

Before merge, P2 must prove at least:

- React Flow node/edge IDs remain canonical IDs
- endpoints and canonical edge types remain traceable
- deterministic sorted layout input and stable layout output mapping
- search/selection state is Presentation-only
- repository-controlled text is rendered without HTML/script execution paths
- projection/result digest and structure are unchanged by UI-model/layout preparation
- Classic Viewer remains the existing default path
- Explorer build succeeds from pinned package versions
- P0/P1 tests and repository regression remain green
- zero `src/core/**` changes


## 15. P3 — Architecture Layers, Containers, Drill-down contract

P3 adds deterministic **Presentation-only hierarchy** to the opt-in Human Explorer. It does not alter `kneekura.graph/v1`, `core.analysis-result/v1`, or `kneekura.explorer-projection/v1`.

### P3 hierarchy derivation

The hierarchy is derived only from already-traceable P1/P2 metadata:

1. root container — all canonical UI nodes;
2. architecture layer — the existing P1 `display_family`;
3. kind container — the canonical node `canonical_kind` verbatim;
4. leaf — the canonical node itself.

For the same Explorer UI model, layer order, container IDs, membership, breadcrumbs, and visible scope must be deterministic.

Layer/container IDs are **Presentation identities only**. They are not canonical graph node IDs and must never appear as replacement canonical nodes, Claim subjects, Evidence identities, Coverage identities, or canonical edge endpoints.

### No synthetic React Flow semantics

P3 does not add layer/container records to the React Flow canonical node set. React Flow graph nodes continue to use canonical `node_id` values and graph edges continue to use canonical `edge_id`, endpoints, and `canonical_type`.

Containers are navigation/filter surfaces outside the canonical graph. They may select which canonical nodes are visible; they may not create group nodes inside `canonical.graph.nodes` or connector edges inside `canonical.graph.edges`.

### Layer filtering and boundary edges

Layer selection is UI visibility state only.

An edge is rendered in the current scope only when **both canonical endpoints are visible**. If exactly one endpoint is visible, P3 may report that canonical edge as a hidden boundary edge for UI accounting, but it must not:

- redirect the edge to a container;
- create a proxy edge;
- reverse the edge;
- change its canonical type;
- infer a new architecture relationship.

An edge with two hidden endpoints is simply outside the current scope.

### Drill-down and breadcrumbs

P3 drill-down follows the deterministic hierarchy:

`All architecture -> display_family -> canonical_kind -> canonical node detail`.

Breadcrumb and Up navigation modify Presentation state only. Selecting a canonical node continues to use the P2 source-traceable detail surface. Search operates only over canonical nodes visible in the current scope and treats labels/IDs/kinds as inert strings.

### Failure isolation and security

Invalid hierarchy membership, foreign layer/container IDs, parent cycles, foreign node IDs, or an edge whose canonical identity/endpoints/type no longer match must fail the Presentation path closed.

Repository-controlled text remains inert data. P3 must not introduce `dangerouslySetInnerHTML`, executable Markdown/HTML, `eval`, string-generated code, script URLs, or instruction authority.

Hierarchy/layout/navigation failures must not mutate the Explorer Projection, canonical graph, canonical AnalysisResult, Claim/Evidence/Coverage data, or AnalysisResult status.

### Classic Viewer and P4 boundary

Classic `serve` remains the default Viewer. P3 remains available only through the explicit Explorer build/projection/serve path.

P4 KNEEKURA-specific semantic visualization remains deferred. P3 architecture layers are generic Presentation organization; they must not encode M5/M6 conclusions, YSM rendering semantics, packet success/failure, Evidence authority, or domain-specific truth into layer/container membership.

### P3 acceptance subset

Before merge, P3 must prove at least:

- deterministic root/layer/kind hierarchy for identical UI input;
- one-to-one canonical node membership with no synthetic React Flow node identities;
- canonical edge IDs/endpoints/types remain unchanged in every visible scope;
- boundary-crossing edges are hidden rather than rewired;
- layer/container/breadcrumb state does not mutate canonical inputs;
- scoped search keeps repository-controlled text inert;
- P0/P1/P2 Presentation guards and full repository regression remain green;
- `src/core/**` remains unchanged;
- Classic Viewer remains default and P4 stays independently implementable.


## 16. P4 — KNEEKURA Semantic Visualization contract

P4 makes **existing KNEEKURA canonical semantics easier to distinguish in the opt-in Explorer**. It is a Presentation-only decoration layer over the merged P1-P3 stack. P4 does not add analyzers, Evidence, Claims, Coverage entries, graph nodes, graph edges, transport stages, runtime observations, or YSM conclusions.

### Allowed P4 inputs

P4 may consume only signals that already exist in the Explorer Projection or its detached canonical snapshots:

- exact canonical node `kind` and P1 `display_family`;
- exact canonical edge `id`, `from`, `to`, and `type`;
- explicit canonical `runtimeObservation` / `runtime_observed` flags when present;
- explicit canonical `transport_stage` such as M0-M6 when present;
- exact Claim `status`, `evidence_links`, `counterevidence_links`, and `coverage_ref`;
- exact Coverage `role` and `status`;
- exact AnalysisResult `status` and existing UNKNOWN records.

P4 must not fill a missing signal from naming, adjacency, UI layout, later-stage observation, or visual proximity.

### Fixed Presentation domains

P4 may map canonical kinds/types to a fixed set of **visual domains**:

- source
- Forge
- network
- runtime
- Molang
- animation
- bone
- resource
- generic semantic
- external
- canonical fallback

These domain names are Presentation tokens only. They do not replace `canonical_kind`, `canonical_type`, Claim type/status, Coverage status, or Evidence authority.

Repository-controlled labels never become CSS selectors, class names, executable markup, or semantic-domain names. Unknown/unrecognized kinds fall back to the fixed `canonical` token.

### Runtime and M0-M6 rules

Runtime visualization follows the existing KNEEKURA evidence contract exactly:

- `runtimeObservation=true` may be shown as observed;
- `runtimeObservation=false` may be shown as unobserved;
- **unobserved is not failed**;
- a later M-stage must not visually fill or imply an earlier missing stage;
- M5 and M6 remain distinct;
- M5 must not be styled or labeled as proof that YSM applied the Molang value;
- `ysm_state_correlated` must not be promoted to M6;
- command failure evidence must not be converted into a successful M4 token.

A transport-stage badge may be shown only when the canonical edge already carries that exact `transport_stage`.

### Claim, Evidence, Counterevidence and Coverage

Node detail may add visual badges around exact Claim/Coverage statuses, but the original status string remains visible.

P4 may use fixed UI tones for readability, for example FAILED, unresolved/unknown/unexplored, verified-with-limits/partial, verified, and analyzed. The tone is not a new canonical status and must never be written back.

Evidence and Counterevidence links displayed by P4 are copied from the existing Presentation Claim metadata. P4 must not rank, merge, discard, or synthesize those links.

### Edge inspection

P4 may allow selecting a canonical edge. The detail surface must show the same canonical edge ID, source, target and type plus direct runtime/stage decoration when present.

Edge color/style never changes the edge identity, endpoints, direction, canonical type, or Evidence meaning.

### Failure isolation and security

Semantic decoration must fail closed on a canonical/UI identity mismatch.

Repository-controlled strings remain inert React text/JSON data. P4 must not introduce executable HTML/Markdown, `dangerouslySetInnerHTML`, `innerHTML`, `eval`, generated functions, script URLs, or repository-text-driven CSS selectors.

A decoration/render failure is a Presentation failure only and must not mutate the Explorer Projection, canonical graph, AnalysisResult, Evidence, Claim, Coverage, UNKNOWN, warning, or failure state.

### Scope exclusions

Classic `serve` remains the default Viewer. P4 remains opt-in through the Explorer path.

**Render Pack and pixel-parity work are explicitly outside P4.** Minecraft/YSM runtime capture, offline Render Pack compilation, shader/sampler replay, authoritative-vs-predicted rendering, and golden pixel comparison belong to the separate KNEEKURA-LAB / offline Viewer fidelity work. P4 may visualize CODE-LAB evidence about those concepts only when such canonical evidence already exists; it does not implement rendering parity.

### P4 acceptance subset

Before merge, P4 must prove at least:

- fixed-domain visualization never replaces canonical node/edge identities;
- canonical edge endpoints/type and exact M-stage remain source-traceable;
- unobserved is visually distinct from failed;
- M5 and M6 stay separate and no missing stage is filled;
- Claim status, Evidence, Counterevidence and Coverage remain exact and visible;
- hostile repository labels remain inert and cannot influence executable styling;
- P0-P3 Presentation guards and full repository regression remain green;
- `src/core/**` remains unchanged;
- Classic Viewer remains default;
- Render Pack/pixel-parity work remains separately implementable.
