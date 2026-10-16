# Evidence workbench acceptance and architecture audit

Validated 2026-10-16 against upstream `a8d460e822f38010ce48080fe6f7bcd71c43f5a4`.

## Repository purpose retained

`AGENTS.md` defines AI-assisted, human-oriented code analysis: deterministic/runtime evidence plus direct source inspection and separately attributed AI interpretation. This extension supplies imported evidence and bounded investigation, not autonomous code generation. Existing production human-analysis IR and offline artifact requirements remain intact. The three engines stay isolated; agreement cannot promote canonical truth. Agent-facing summaries remain a separate mailbox/MCP renderer.

## Implemented acceptance surfaces

- RefactoringMiner commit refactorings and separately exported AST mappings/raw action text; before/after snapshot navigation and existing strong-edge impact traversal.
- Explicit-ID saved run comparison with first observed differences, paired durations and source references; never JVM rewind.
- Joern data-flow/usage imports and bounded backward traversal.
- Code Maat CSV and custom sample-history computation, noise exclusions and provenance.
- Explicit, complete ArchUnit baseline comparisons without automatic refreezing.
- Declared instrumentation/sampling/drop/identity reasons; absent evidence leaves execution unknown.
- Same-condition analyzer disagreements, including genuine existing Fabric observations; no voting or cross-engine fusion.
- CPD XML clone groups and separately attributed human annotations; no deletion or equivalence claim.

Native export structures are documented with primary-source references. Fixtures are synthetic schema-derived examples, not evidence that external analyzers ran. ArchUnit/history envelopes are explicitly KNEEKURA-defined. Absolute source paths must be normalized by the caller rather than silently guessed.

## Structural audit and improvements

- One discoverable package entrypoint (`./workbench`), CLI, existing MCP tool, and mailbox renderer exports share the same operations.
- Focused import modules produce existing normalized Fabric observations; no changes to `src/core/**`.
- Additive Explorer metadata preserves immutable canonical graph/result and navigates exact source/snapshot-correlated nodes. Missing or ambiguous identity stays unresolved.
- Optional source materialization uses the existing content-digest-checking Source Broker, including separate before/after bindings.
- Nested import requests compose into comparisons/queries through MCP without reconstructing full envelopes from compact summaries.
- Machine pages bound the complete serialized response; pointer access retrieves omitted details reproducibly by report ID.
- Human HTML/ZIP and agent JSON/Markdown have distinct renderers. Untrusted text is escaped/inert; XML DTD/entity expansion and unsafe paths are rejected.
- New modules are consistently formatted and documented with explicit interfaces, limits and usable request fixtures.
- Repaired the existing npm lockfile by adding 25 missing optional-platform package records. Existing versions and direct dependencies did not change. Clean `npm ci` now succeeds.
- Independent cold-use audit exercised all 15 documented CLI/MCP requests, composed queries, detail access and 4096-byte pages. All substantive findings were resolved.

## Reproducible verification

Node 24.19.0 was used; existing package declares Node >=20.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run explorer:build
npm run presentation:guard
npm install --prefix mcp --ignore-scripts --package-lock=false --no-audit --no-fund
npm --prefix mcp run smoke
node src/cli.mjs workbench --request fixtures/workbench/requests/compare-runs.json --out /tmp/workbench-new-output
```

- Clean install: PASS.
- Full suite: 655 tests passed, 0 failed.
- Explorer production build: PASS, with existing externalized-Node-module/directive/large-chunk warnings.
- CORE/Presentation boundary guard: PASS.
- MCP SDK server smoke: PASS.
- All 15 public request fixtures: CLI bundle and compact MCP page PASS.
- Source Broker: both snapshots materialize; changed source digest fails closed.
- HTML/ZIP manifest includes attached Explorer projection.
- Browser screenshot attempt: BLOCKED by this execution environment (`socket() failed: Operation not permitted`). No browser parity or screenshot verification is claimed. React panel JSX rendering/navigation wiring and escaped output were tested; a production build was generated.

No external analyzer, JVM target, paid service, deployment or target-repository write was executed. Live upstream-tool compatibility and interactive browser behavior beyond the tested contracts remain separate validation work.

## Hosted CI follow-up

Ordinary CI now uses GitHub-hosted Windows; see `CI_RUNNERS.md` for the explicitly retained local live-profile exceptions. The first hosted run passed all 657 tests and Relay Foundation, then exposed a stale nine-tool assertion in the generated Plugin smoke. The corrected smoke keeps the exact tool list, requires the tenth workbench tool, and calls it through the isolated generated stdio bundle. It verifies imported Code Maat metrics, evidence claim level, untrusted-instruction metadata and the full 4096-byte output bound. Local `npm run plugin:package` and `node scripts/smoke-kneekura-code-lab-plugin.mjs` pass with this correction. Final remote results must be read from the latest PR head's checks, not the earlier failed run.
