# Evidence Workbench Implementation Plan

**Goal:** Deliver all eight evidence extensions through one bounded import/compare host and CLI, preserving human/agent presentation separation.
**Architecture:** External artifact adapters produce normalized Fabric observations. Derived comparisons live outside immutable CORE; Explorer and mailbox-oriented outputs consume a validated workbench report.
**Tech Stack:** Node 20+ ESM, node:test, existing Fabric and Explorer interfaces; no new runtime dependencies.
**Spec:** `docs/superpowers/specs/2026-10-16-evidence-workbench-design.md`

## Global Constraints
- No target repository execution or modification, analyzer download, fee, merge or deployment.
- No engine result fusion or canonical truth promotion.
- Preserve concurrent upstream PR work; base source snapshot is a8d460e822f38010ce48080fe6f7bcd71c43f5a4.

## Review Focus
Malformed native input, untrusted paths/XML/HTML, incompatible provenance, ambiguous run alignment, resource amplification.

## Tasks
- [x] Shared contracts: bounded bytes/records, provenance and Fabric observation helpers; tests for immutable/deterministic output and rejected unsafe inputs.
- [x] Static import adapters: RefactoringMiner, Joern, CPD; fixture-based parser and bounded-query tests before implementation.
- [x] History and architecture: CSV/history noise filters and explicit ArchUnit baseline comparisons; test exclusions and incomparable baselines.
- [x] Runtime and disagreement: explicit-ID alignment, metadata reasons, bounded disagreement; test ambiguity and no inferred negatives.
- [x] Integrate host/CLI/Explorer: one request/result API, source links, semantic impact and separate HTML/ZIP/JSON/Markdown renderers; end-to-end fixture tests.
- [x] Refresh README and adapter docs; run focused tests, complete suite, presentation guard and possible build; independent architectural review and fix findings.

Each task must supply tests, real-format examples, limitations and its exported API. Batch verification of related modules before whole-repository regression. Commit local checkpoints after passing tests; parent coordinates any remote persistence.

Verification and bounded limitations: see `docs/WORKBENCH_ACCEPTANCE.md`.
