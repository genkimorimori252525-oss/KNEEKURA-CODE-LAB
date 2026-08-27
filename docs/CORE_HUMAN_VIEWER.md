# CORE Human Viewer v1

Status: Milestone G implementation contract.

The Human Viewer is a consumer of canonical CORE artifacts. It does not
participate in evidence acquisition, Claim construction, verification, or
ReasoningBridge context creation.

## Source modes

The Viewer supports three source modes.

### VIEWER_BUNDLE

Recommended canonical mode.

The bundle contains:

- `viewer-manifest.json` — `core.human-viewer-manifest/v1`
- `analysis-result.json` — canonical `core.analysis-result/v1` with the
  optional inline `evidence` array omitted
- `graph.json` — existing KNEEKURA graph
- `refs/evidence/*.json` — one canonical EvidenceRecord per stable ref

The manifest contains only evidence index metadata and ref paths. Observation
payloads are not included in the initial browser load.

Evidence bodies are fetched only when the user drills into an Evidence ref.

### ANALYSIS_RESULT

Transition/debug mode.

If `/analysis-result.json` exists without a Viewer manifest, the Viewer can
load the canonical result directly. Inline EvidenceRecords are supported.

This is compatible but is not the preferred large-Ledger deployment because
an inline result may transfer the entire Evidence Ledger.

### GRAPH_ONLY

Compatibility mode.

If no canonical result is available, the Viewer falls back to the existing
`graph.json` behavior.

Search, kind/edge filters, TLM↔YSM boundary filtering, runtime observation
filtering, Molang transport summaries, fidelity matrices, packet/runtime
overlays, and raw bone/network evidence remain available.

## Canonical result relationship

The same `core.analysis-result/v1` produced by `core.analyze` can be
consumed by:

- `renderAnalysisForAI()`
- Human Viewer bundle generation
- Jolly Research Mailbox adapter

No separate human-analysis semantics are introduced.

The Viewer may organize information for readability, but it cannot promote,
reject, or rewrite a Claim.

Human-facing prose is not written back into:

- Evidence Ledger
- ClaimRecord
- AnalysisResult
- Evidence Capsule
- ReasoningTask

## Focused graph

When an AnalysisResult is loaded, the default graph is a question-focused
projection derived only from canonical result refs:

- `affected_symbols[].node_id`
- `graph_paths[].edge_id/from/to`
- Claim subject `node_id`

The Viewer does not invent semantic edges.

Users can switch to the full graph at any time.

If a focused result has too few explicit edges, the Viewer may expose directly
adjacent existing graph edges to avoid an unusably isolated node. Those edges
must already exist in `kneekura.graph/v1`.

Graph layout is deterministic for the same nodes/edges.

## Human panels

The Viewer exposes:

- session / snapshot / repository identity
- architecture graph
- selected node details
- responsibility/summary
- callers / callees
- domain semantic edges
- runtime overlay
- Claims
- support Evidence refs
- counterevidence refs
- Evidence provenance/source anchors
- Coverage Manifest
- FAILED / UNEXPLORED items
- UNKNOWNs
- warnings / failures
- recommended validation
- KNEEKURA fidelity / network / Molang summaries

## Responsibility text

Responsibility text is presentation metadata only.

Preferred existing sources are:

1. explicit node `responsibility`
2. node `summary`
3. node `description`
4. Understand Anything imported summary
5. existing semantic description metadata

Understand Anything therefore improves large-scale human comprehension without
becoming verifier authority.

If no such text exists, the Viewer displays responsibility as unavailable
rather than asking an LLM to invent it.

## Claim and Evidence display

Claim status is displayed exactly as stored.

Examples:

- VERIFIED
- VERIFIED_WITH_LIMITS
- UNRESOLVED
- REJECTED

The Viewer keeps support Evidence and counterevidence visually distinct.

M5 client-command consumption is never rendered as M6 formal state application
unless the canonical AnalysisResult contains the corresponding verified M6
Claim.

## Lazy Evidence drill-down

`core.human-viewer-manifest/v1` contains an `evidence_index` keyed by stable
EvidenceRecord ID.

Each entry exposes only:

- ID
- kind
- trust class
- provider ID/version
- compact provenance/source anchor
- ref path

The observation body remains in the ref file.

The browser:

1. loads manifest
2. loads lightweight AnalysisResult
3. loads graph
4. does not fetch Evidence bodies
5. fetches one EvidenceRecord only when its ref is selected
6. caches that EvidenceRecord for repeated drill-down

The loader verifies that a fetched ref returns the requested Evidence ID.

## Raw compatibility drill-down

The structured human panels do not remove low-level KNEEKURA data.

Selected nodes expose raw node data.

Relations expose existing:

- `evidence`
- `fields`
- `samples`
- stage metadata

This preserves packet, runtime, palette, pose, and bone investigation details
that were previously visible through raw JSON selection output.

## Bundle generation

Generate a lazy Viewer bundle from an existing AnalysisResult and graph:

~~~text
node src/cli.mjs viewer-bundle \
  --result dist/analysis-result.json \
  --graph dist/graph.json \
  --out dist/viewer-bundle
~~~

Serve it:

~~~text
node src/cli.mjs serve --bundle dist/viewer-bundle
~~~

Legacy graph-only serving remains:

~~~text
node src/cli.mjs serve --graph dist/graph.json
~~~

Bundle writer paths are contained within the requested bundle root.

## Non-goals

Milestone G does not:

- modify Claim verification
- modify Evidence Ledger semantics
- call an LLM
- create provider credentials
- change `kneekura.graph/v1`
- freeze the plugin contract
- implement Milestone H YSM acceptance
- use human prose as AI context
