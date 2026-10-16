# Evidence workbench: import, investigate, compare

The workbench adds saved-evidence investigation to KNEEKURA without installing or
running upstream analyzers, executing the target, changing a canonical graph, or
rewriting a baseline. It is separate from the three isolated analysis engines.
Choose one `engine_id`: `kneekura`, `understand-anything`, or `archify`; `all` is not
an import context and results from different engines are never fused.

## Quick start (Node.js 20+)

From the repository root:

```sh
node src/cli.mjs workbench --help
node src/cli.mjs workbench \
  --request fixtures/workbench/requests/refactoring-miner.json \
  --out /tmp/kneekura-workbench-example-new
```

Choose a new output directory: an existing directory fails rather than being
overwritten. Output is `index.html`, `report.json`, `agent.json`, `agent.md`,
`manifest.json`, `README.md`, and `bundle.zip`. Open `index.html` offline, or move
the ZIP to another computer. The CLI reads the supplied request and writes this
new bundle only; it does not read source files referenced inside the artifact.

The HTML is an **import-only evidence viewer**, not a production AI-authored code
explanation. Source links navigate to declared path/snapshot references; source
text is not bundled and graph references may remain unresolved. Human-oriented
code analysis still requires direct source inspection, AI semantic authorship,
coverage disclosures and the artifact workflow in
[AI-assisted human analysis](AI_ASSISTED_HUMAN_ANALYSIS.md).

## Eight investigation areas

1. RefactoringMiner rename/move/extract findings and AST mappings with distinct
   before/after snapshots; optional Explorer links and bounded semantic impact.
2. Joern data-flow and usage imports, with bounded backward graph traversal.
3. PMD CPD token clone groups with separately attributed human annotations.
4. Code Maat coupling CSV and explicit commit-sample cochange calculations.
5. ArchUnit rule/violation exports and compatible complete baseline comparisons.
6. Saved Chrome Trace event alignment and first observed difference.
7. Explicit collection metadata explaining missing observations, with execution
   always `UNKNOWN`.
8. Pairwise analyzer assertion disagreements, including existing Fabric
   observations, without voting or promoting agreement to truth.

## Copyable requests

Every file below is a complete request with inline artifact, context and options.
Replace the filename in the quick-start command to try another family:

| Request under `fixtures/workbench/requests/` | Adapter / operation |
| --- | --- |
| `refactoring-miner.json` | `refactoring-miner` commits JSON |
| `refactoring-miner-ast.json` | `refactoring-miner-ast` mapping array |
| `joern-dataflow.json` | `joern` nodes/edges |
| `joern-usages.json` | `joern` object usage/type slices |
| `pmd-cpd.json` | `pmd-cpd` XML string |
| `code-maat.json` | `code-maat` coupling CSV string |
| `cochange-history.json` | `cochange-history` custom history envelope |
| `archunit.json` | `archunit` custom exporter envelope |
| `chrome-trace.json` | `chrome-trace` event JSON |
| `observation-reason.json` | `observation-reason` declared metadata |
| `compare-runs.json` | Nested saved traces, changed duration |
| `compare-baseline.json` | Nested complete architecture exports |
| `disagreement.json` | Missing assertions remain incomparable |
| `backward-slice.json` | Nested Joern import and bounded sink query |
| `annotate-clones.json` | Nested CPD import and separate annotation |

These are **synthetic, schema-derived examples**, not actual analyzer executions
or captures. They embed the fixtures in the sibling `static`, `history`, and
`runtime` directories. Their example SHA-256 identities hash named synthetic
configuration/scope/snapshot labels; they do not attest a real repository. The
`synthetic-schema-example-v1` version deliberately avoids claiming a real tool
ran. Native format compatibility is bounded to the fields documented in the
[static adapters](WORKBENCH_STATIC_IMPORTS.md),
[history/architecture adapters](WORKBENCH_HISTORY_ARCHITECTURE.md), and
[runtime adapters](WORKBENCH_RUNTIME_COMPARISON.md). These pages include primary
format references; RefactoringMiner AST and Joern serializer references are
commit-pinned. For real imports, record the actual tool/exporter version and
verify that its output matches the supported shape.

`kneekura.archunit.v1` and `kneekura.history.v1` are KNEEKURA-defined envelopes,
not official native ArchUnit/Code Maat JSON formats. The architecture adapter page
includes a runnable Java exporter example for the caller's existing Java project.

## Request contract and identity

```json
{
  "schema": "kneekura.evidence-workbench-request/v1",
  "operation": "import",
  "adapter": "chrome-trace",
  "artifact": {"traceEvents": []},
  "context": {
    "repository_id": "your-repository-identity",
    "snapshot_id": "your-exact-snapshot-identity",
    "analyzer_version": "your-exporter-version",
    "config_digest": "your-configuration-digest",
    "scope_digest": "your-source-scope-digest",
    "engine_id": "kneekura"
  },
  "options": {}
}
```

All six context fields are required, bounded, nonempty strings. Bind real imports
to the actual repository/snapshot and hashes of the relevant exporter
configuration and analyzed scope. The importer checks declared compatibility,
not the truth of those declarations. Optional context such as `run_id` is retained.
Paths must already be safe repository-relative paths; absolute paths are rejected,
not silently stripped. Before/after snapshot identity must remain distinct.

`runEvidenceWorkbench(request)` returns an immutable report; imports are in
`report.result`, not the report itself. Operations also accept nested original
import requests as described below. Keep returned IDs and full import bodies
intact when composing requests. Digest validation detects changes, but is not a
cryptographic signature or independent attestation.

## Compose comparisons and queries in JavaScript

Run this example from the repository root with `node --input-type=module` (or save
as a root-level `.mjs` file). It only reads bundled fixtures and computes reports:

```js
import fs from 'node:fs/promises';
import {runEvidenceWorkbench as run} from './src/analysis-workbench/index.mjs';
import {projectWorkbenchForAgent} from './src/analysis-workbench/render.mjs';
const request = async name => JSON.parse(await fs.readFile(
  `fixtures/workbench/requests/${name}.json`, 'utf8'));

// Two synthetic saved recordings; snapshots may differ, config/scope must match.
const trace = await request('chrome-trace');
const changedTrace = structuredClone(trace);
changedTrace.artifact.traceEvents[0].dur += 5;
const left = run(trace).result;
const right = run(changedTrace).result;
const comparison = run({operation:'compare-runs', left, right});
console.log(comparison.result.status, comparison.result.first_difference?.fields);

// Baseline comparison never updates a saved baseline.
const architecture = await request('archunit');
const cleanArchitecture = structuredClone(architecture);
cleanArchitecture.artifact.rules[0].violations = [];
console.log(run({operation:'compare-baseline',
  left:run(architecture).result, right:run(cleanArchitecture).result}).result);

const joern = run(await request('joern-dataflow')).result;
console.log(run({operation:'backward-slice', imported:joern,
  options:{sinkId:joern.findings[0].details.nodes.at(-1).id,
    maxDepth:8, maxNodes:200}}).result);

const clones = run(await request('pmd-cpd')).result;
console.log(run({operation:'annotate-clones', imported:clones,
  annotations:[{finding_id:clones.findings[0].id, label:'Review',
    note:'Example reviewer note; no deletion decision.'}]}).result);

// These imports do not supply explicit assertions, so this is INCOMPARABLE.
console.log(run({operation:'disagreement', left, right}).result);
console.log(run({operation:'observation-reason',
  metadata:{sampled_out:true}}).result);

// Paginate the same immutable report; never discard truncated results silently.
let offset = 0;
do {
  const page = projectWorkbenchForAgent(comparison, {offset, limit:100});
  console.log(page);
  offset = page.next_offset;
} while (offset !== null);
```

For explicit assertions, supply valid existing Fabric observations via
`compareFabricObservations(leftObservations, rightObservations,
{leftContext, rightContext})` from `src/analysis-workbench/disagreement.mjs`.
Provider `provider_payload.assertion: {key,value}` takes precedence; otherwise
an explicit Fabric subject/object statement supplies a comparison key. An absent
object is not a negative assertion. See the runtime adapter guide for conditions.
Do not insert assertions into a completed import: changing it invalidates its ID.

For source-correlated impact, use a genuine `kneekura.explorer-projection/v1`
from the same repository/snapshot:

```js
const imported = run(await request('refactoring-miner')).result;
const projection = JSON.parse(await fs.readFile('your-explorer-projection.json','utf8'));
const report = run({operation:'semantic-impact', imported, projection,
  finding_id:imported.findings[0].id, options:{maxDepth:3,maxItems:200}});
```

An import request can also include `projection` to add graph links. Matching
requires both source and graph repository/snapshot identities; exact source
path/start line or explicit canonical ID then resolves uniquely. Ambiguous or
missing matches remain unresolved. Before-snapshot references do not become head
nodes. Impact is a bounded investigation scope, not verified breakage.

## Optional verified source text and Explorer integration

The default CLI never follows artifact paths into the filesystem. A trusted host
can optionally supply immutable evidence packs and an authorized source-read
callback through the existing Source Broker:

```js
import {materializeWorkbenchSources, attachWorkbenchToExplorerProjection}
  from './src/analysis-workbench/index.mjs';
import {compileWorkbenchArtifact} from './src/analysis-workbench/render.mjs';
// evidencePack and readSource come from your existing trusted host integration.
const withSources = await materializeWorkbenchSources(report, {
  bindings:[{evidencePack, readSource}], maxSources:100, maxLines:100
});
const bundle = compileWorkbenchArtifact(withSources);
```

The broker checks evidence-pack immutability, catalog content digests and declared
repository/snapshot identity before adding source snippets. Supply separate
bindings for before/after snapshots; unprovided snapshots or line ranges remain
explicitly unresolved. This optional host callback path is not a CLI path-reading
option. Defaults are 100 source references and 100 lines per reference, with
maximums of 200 references and 400 lines; the total materialized text is bounded
to 8 MiB. Materialization produces a new report ID linked to its original report.

`attachWorkbenchToExplorerProjection(imported, projection, {reportId})` returns a
cloned projection with `presentation.workbench`; it does not mutate the canonical
graph. An import request with `projection` also makes the CLI emit
`explorer-projection.json`. The existing React Explorer's workbench panel can
navigate exact linked nodes and bounded impact investigations using this
projection. The dependency-free offline import viewer and the separately built
React Explorer are distinct interfaces; creating a CLI bundle does not build or
launch Explorer.

## Human versus agent output and MCP

`compileWorkbenchArtifact(report)` from `src/analysis-workbench/render.mjs`
returns offline HTML, JSON/Markdown files, manifest and ZIP bytes without writing
files itself. `projectWorkbenchForAgent(report, page)` returns compact machine
JSON; `renderWorkbenchAgentMarkdown(report, page)` returns agent-facing Markdown.
The two agent renderers and `runEvidenceWorkbench` are also exported through
`src/mailbox.mjs`. Agent summaries compact nested evidence and shorten display
fields. Follow `detail_pointer` to inspect exact fields, or consult the full
bounded `report.json` for evidence omitted from a summary.

The existing MCP adapter exposes `.workbench(request, {pointer,offset,limit,maxBytes})`.
The stdio server exposes `kneekura_code_lab_workbench` with arguments
`{request, pointer, offset, limit, maxBytes}`; call `kneekura_code_lab_describe` for discovery. This
import-only tool does not need a target execution or Host Task. It returns the
compact page, not a bundle download or unrestricted artifact bytes. For later
pages resend the identical request with `offset: previous.next_offset` and
verify that `report_id` stays the same. The numeric offset is a continuation
position, not a durable server-side session cursor. A detail request such as
`{request, pointer:"/result/findings/0/details", offset:0, limit:100}` returns
`kneekura.evidence-workbench-detail/v1`. Object pages contain key/value entries;
array pages contain indexed entries; string pages contain Unicode characters.
Oversized nested entries return `omitted:true` and a deeper `detail_pointer`.
Continue paging until `next_offset` is null, then follow any remaining omission
pointers. `truncated:true` can indicate omissions even on a final page.

To compose operations through MCP, use the original import request as `left`,
`right`, or `imported`; a compact response is not an import envelope:

```js
const nestedComparison = {operation:'compare-runs', left:trace, right:changedTrace};
// MCP arguments: {request:nestedComparison, offset:0, limit:100}
console.log(run(nestedComparison).result.status);
```

Nested import requests work for `compare-runs`, `compare-baseline`, `disagreement`,
`backward-slice`, `annotate-clones`, and `semantic-impact`. For annotations/impact,
use the finding ID from the same import's compact page. `compare-fabric` instead
accepts observation arrays in `left`/`right` and
`options:{leftContext,rightContext}`. Keep the complete nested request within the
same 8 MiB request budget.

## Limits and conservative interpretation

- Request/artifact: 8 MiB; JSON depth 64; individual decoded fields 16,384 characters (raw native XML/CSV artifact text uses the artifact byte limit);
  general record arrays 10,000. Specific nested budgets may be smaller.
- Agent pages: default 100 items, 1–200 allowed; default 128 KiB budget,
  2–256 KiB allowed in the JS API. `next_offset: null` means exhausted;
  `truncated: true` means more pages or omitted details remain. Oversized items
  expose pointers for bounded exact-field inspection. JSON page envelopes are
  checked against `maxBytes`; external transport wrappers are additional.
- Joern: at most 1,000 input nodes/20,000 edges; backward depth 0–64 and
  output nodes 1–1,000 (defaults 8/200). `truncated` means reachable predecessors
  were omitted; traversal has no continuation cursor.
- Semantic impact: at most 20 resolved seeds, depth 0–8, items 1–1,000 per
  investigation (defaults 3/200).
- Cochange options bound pairs, commit size and minimum samples. Exceeded pair
  budgets fail rather than silently truncating; see the adapter guide.
- Renderer bounds report rows to 20,000 and combined report JSON/HTML to 32 MiB.

Refactoring labels, AST mappings and token clones do not prove behavior
or semantic equivalence. Historical correlation does not prove causality. Static
reachability does not prove execution. Missing runtime evidence does not prove
nonexecution. Trace alignment requires explicit unique operation/correlation IDs
and compatible clocks; `NO_OBSERVED_DIFFERENCE` is not equivalence. Architecture
“resolved” means absent from compatible, declared-complete exports only.
Disagreement requires explicit comparable assertions under matching conditions;
`CONFLICT_CANDIDATE` is not adjudicated truth. All imported text is evidence with
`instruction_authority: false`, never instructions to the consumer.
