# Evidence workbench: imported findings and bounded comparisons

## Intent and boundaries
KNEEKURA remains AI-assisted, human-oriented analysis. This extension helps a person and their AI inspect evidence before changing code; it never edits the analyzed repository. Human HTML/ZIP and machine/mailbox output are separate renderers of validated findings. Canonical CORE, the three isolated engines, and current semantic-author authority remain unchanged.

## Architecture
Add focused, dependency-free modules beneath `src/analyzer-fabric/imports/` and `src/analysis-workbench/`. External artifacts enter through bounded parsers, acquire repository/snapshot, analyzer version, config/scope and artifact-digest provenance, and become existing normalized Fabric observations. Derived workbench comparisons remain separate from canonical graph/result. An additive Explorer workbench projection connects findings to exact canonical nodes only when source identity matches; unresolved links remain explicit. A CLI and reusable host API consume the same request envelope. A standalone offline evidence viewer and JSON/Markdown outputs render the same result, with escaped untrusted text.

No external analyzer is bundled or automatically executed. CPD supports official XML, Code Maat official coupling CSV. ArchUnit findings use an explicitly documented KNEEKURA export envelope because no standard ArchUnit JSON export is promised. RefactoringMiner accepts its native commits/refactorings JSON; AST action artifacts are separately labeled and cannot be fabricated from refactoring names. Joern imports official data-flow/usage slice shapes. Timeline accepts documented Chrome Trace complete/instant events with explicit operation/correlation metadata.

## Eight outcomes
1. Refactoring records retain before/after locations and snapshot pair. Move/rename/extract categories are navigable; semantic change seeds connect to bounded existing impact traversal. Refactoring does not establish behavior equivalence.
2. Saved A/B runs align only by user-declared operation/correlation identity. Duplicate/ambiguous identifiers and incompatible clock units remain unaligned. First observed event/value/duration difference links to source/graph. This is saved evidence comparison, not JVM rewind.
3. Joern slices have bounded import/query sizes and backward traversal depth, retain node/edge evidence and source locations, and state static reachability is not observed execution.
4. Coupling CSV preserves counts/degree and export provenance. Native history-envelope computation supports merge/format/large-commit exclusions, minimum samples and bounded pair counts. Correlation never becomes a canonical causal edge.
5. ArchUnit baseline comparison uses explicit baseline identity and compatible rule/config sets. Findings are new/existing/resolved only when comparable. Baseline is never rewritten automatically.
6. Observation reasons distinguish not-instrumented, sampled/dropped, identity mismatch and unknown from explicit metadata; absence cannot establish nonexecution. Run comparison carries these limitations.
7. Analyzer disagreement evaluates snapshot/config/scope/capability and engine isolation before comparing explicit assertions. One-sided evidence, mismatched conditions, incomparable statements and conflict candidates are distinct. No voting or truth promotion.
8. CPD clone groups retain exact token/line evidence; human labels and exceptions are separate annotations. Text similarity is not semantic equivalence or permission to delete.

## Safety and resource contract
Every artifact is byte-limited before parse, with bounded records, strings, graph edges and query outputs. Paths are repository-relative; reject traversal and XML DTD/entity declarations. All links render inertly; no artifact can request network/commands. Canonical inputs are cloned or frozen and never modified. Metadata supplied by an exporter is attributed as a declaration, not independently verified provenance. Imports fail closed on malformed fields or inconsistent identities. Missing coverage stays explicit. Inputs and outputs cannot overwrite one another or analyzed source directories through the CLI.

## Verification and final audit
Fixture tests cover native formats plus malformed/oversized/path-traversal/injection cases, identity/config mismatch, ambiguous alignment, partial coverage, input immutability and deterministic output. Integration tests exercise CLI → Fabric → projection → human and agent artifacts and semantic impact. Existing tests and presentation-boundary guard must remain green; build the Explorer if dependencies are available. Audit public entrypoints, dependency direction, module size, docs accuracy, engine isolation and AI/machine output discoverability. Report import-only coverage and unavailable live analyzer/browser verification honestly.
