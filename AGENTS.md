# AGENTS.md

## Repository intent

KNEEKURA-CODE-LAB is **AI-assisted by design** for human-oriented code analysis.

The project is not trying to remove AI from semantic understanding. Deterministic/static analyzers, runtime evidence, canonical graph/result contracts, Coverage, Evidence and Ask-Graph provide traceable evidence. An AI semantic author is expected to combine that evidence with direct source reading and produce a useful human explanation/artifact.

Read `docs/AI_ASSISTED_HUMAN_ANALYSIS.md` and `config/human-analysis-delivery.v1.json` before fulfilling a human-oriented code-analysis request.

## Trigger: human-oriented code analysis

When the user asks for requests such as:

- `人間用にコード分析して`
- `コードを教えて` / `このコードを案内して`
- `このリポジトリを人間向けに説明して`
- `human-oriented code analysis`
- `explain/map/guide this codebase for a human`

treat the request as **artifact-first human analysis**, not as a request for chat-only prose.

## Default delivery

Unless the user explicitly requests another format:

1. Analyze with the strongest available combination of KNEEKURA deterministic evidence, registered/imported analyzers, runtime evidence, Ask-Graph, direct source inspection and AI semantic reasoning.
2. Produce a portable human-analysis artifact.
3. Prefer a **self-contained offline HTML guide** as the primary artifact because it is one-click/openable without installation.
4. Also provide a **ZIP companion bundle** when there are multiple supporting files.
5. Keep the chat response short: summarize what was produced, major coverage gaps, and link the actual artifacts.

Preferred bundle:

- `index.html` — self-contained interactive guide
- `manifest.json` — artifact/source identity and generation metadata
- `analysis.json` — typed human-analysis IR
- `sources.json` — source files/ranges/canonical IDs supporting each section
- `coverage.json` — deterministic scanner coverage, AI-read coverage, unknowns and gaps
- `README.md` — how to open/use the artifact
- optional `architecture.svg`, `knowledge-graph.json`, `tour.json`

If the current environment cannot create downloadable files, do **not** silently degrade to prose-only. Provide executable generator code/script that creates the same artifact bundle, plus only the minimum prose needed to run it.

If the platform offers a better directly viewable interactive artifact, it may be the primary presentation, but keep a portable self-contained HTML/ZIP companion when practical.

## AI role and evidence boundary

AI semantic interpretation is a first-class part of the intended system.

Use these labels/concepts consistently:

- `CANONICAL_FACT` — directly supported by KNEEKURA canonical graph/result or registered deterministic/runtime evidence.
- `AI_INTERPRETATION` — architecture grouping, semantic explanation, concept/domain naming, guided narrative or inference authored by the AI.
- `COVERAGE_GAP` — source/language/area not fully handled by deterministic analyzers or not inspected deeply enough.
- `UNKNOWN` — unresolved by available evidence; do not fill with confident prose.

AI-authored interpretation may be useful and opinionated, but it must remain traceable to source files/ranges or canonical IDs and must not be written back as if it were a canonical CORE fact.

## Missing language-specific scanner

A missing deterministic language scanner is **not** a reason to refuse or stop human-oriented analysis.

For example, if a TypeScript repository is not fully handled by current deterministic scanners, the AI should:

1. record the deterministic coverage gap;
2. inspect the TypeScript source directly using available repository/file tools;
3. create the human artifact anyway;
4. mark architecture/semantic conclusions from that path as `AI_INTERPRETATION` unless backed by imported/deterministic evidence;
5. never pretend the missing scanner produced canonical facts.

## Design inspirations

The intended hybrid takes complementary ideas from:

- **Understand Anything** — deterministic/static structure plus AI/agent semantic analysis, knowledge graph, architecture/domain grouping and guided tours.
- **Archify** — AI-authored typed presentation IR followed by deterministic validation/rendering into portable human artifacts.
- **KNEEKURA existing analysis** — canonical graph/result identity, evidence/provenance, static/runtime separation, Coverage/UNKNOWN, domain-specific Forge/YSM semantics, impact planning and Ask-Graph traceability.

Do not copy upstream code merely to imitate the UX. Respect repository OSS provenance/vendoring rules.

## Existing deterministic Presentation remains valid

Human Presentation v2, Ask-Graph, Change Impact and Confidence/Evidence Inspector keep their existing fail-closed canonical behavior. The AI Semantic Author sits **above** those evidence/presentation contracts and consumes them; it does not weaken them.
