# Saved runtime evidence and analyzer disagreement

These APIs import saved evidence. They do not run code, record traces, rewind a VM, edit a repository, or promote findings to canonical truth.

## Chrome Trace import

`importChromeTrace(artifact, context, options = {})` accepts a JSON string, Buffer, JSON event array, or `{traceEvents:[...]}` object. It imports complete (`X`) and instant (`i`, `I`) events. Other phases produce explicit warnings and are omitted. `ts` and `dur` use microseconds, even when `displayTimeUnit` requests a different display unit. Complete events require finite nonnegative `dur`; timestamps must be finite numbers. Malformed supported events fail the import.

The standard event format comes from [Perfetto's Chrome JSON documentation](https://perfetto.dev/docs/getting-started/other-formats#chrome-json-format). This implementation intentionally supports a subset; it does not reconstruct begin/end pairs or import counters or async flow.

Repository, snapshot, analyzer version, config/scope digests and isolated engine ID are required by the common import contract. Optional `run_id` labels a recording. Each imported finding is `RUNTIME` / `RUNTIME_OBSERVED` and retains event order, name, phase, timestamp and duration.

Additional `args` fields are KNEEKURA exporter conventions, not standard Chrome promises:

- `operation_id` and `correlation_id`: nonempty strings, together forming the exact alignment key. `options.operation_field` and `options.correlation_field` can select alternative argument names.
- `clock_scope`: declared clock domain, such as `monotonic-host-A`.
- `value`: observed JSON value. Omission remains distinct from explicit null.
- `source`: repository-relative `path`, optional positive `start_line` / `end_line`, optional matching `snapshot_id`.
- `canonical_id`: explicit, unverified canonical-node reference. Importing this text does not independently verify that node.
- `observation_metadata`: collection declarations described below.

No source location or graph identifier is guessed from the event name. Unsafe paths, inconsistent source snapshots, oversized records and deep/malformed JSON fail closed. Strings remain inert data; the human renderer must escape them.

## Comparing saved runs

`compareSavedRuns(leftResult, rightResult, options = {})` requires intact import results and matching engine, repository, configuration and scope. Snapshot IDs may differ: this compares two saved executions across source versions, with each side retaining its own source snapshot. A config/scope difference instead returns `MISMATCH`.

Both IDs must be present and unique on each side. Missing IDs, duplicate IDs and one-sided anchors remain `unaligned`; there is no name, timestamp or fuzzy matching. The comparator preserves artifact event order. Under a matched anchor and compatible explicit clock scope, it compares order, observed value (including presence), name, duration and phase. Absolute timestamps are deliberately not compared across independent recordings. Missing/incompatible clock domains, units or non-runtime capabilities yield `UNKNOWN`.

The result exposes `aligned`, `unaligned`, `differences` and `first_difference`, including both findings and their source references. First means first differing aligned event in the left artifact's event order, not globally earliest wall-clock time. `NO_OBSERVED_DIFFERENCE` means only that these imported events matched; it is not behavior equivalence. Empty or incomplete alignment stays `UNKNOWN`. An observed difference can coexist with unknown or unaligned events.

## Observation reasons

`classifyObservationReason(metadata = {})` returns one primary `reason`, all supported `reasons`, and `execution: 'UNKNOWN'`:

| Explicit exporter declaration | Reason |
| --- | --- |
| `identity_match: false` | `IDENTITY_MISMATCH` |
| `instrumented: false` | `NOT_INSTRUMENTED` |
| `sampled_out: true` or positive integer `dropped_count` | `SAMPLED_OR_DROPPED` |
| Missing metadata or unsupported declaration | `UNKNOWN` |

Multiple reasons retain the table's priority order. `observed:false` alone supplies no explanation. Generic configured sampling rates are not proof that a particular event was sampled out. Absence never proves nonexecution. [OpenTelemetry's SDK specification](https://opentelemetry.io/docs/specs/otel/trace/sdk/) describes sampling and recording limits; these explicit conventions do not claim to import arbitrary OpenTelemetry exports.

## Analyzer disagreement

`compareAnalyzerFindings(leftResult, rightResult, options = {})` checks intact imports and exact engine/repository/snapshot/config/scope compatibility before proposing disagreement. Different engines remain isolated. Provider names and versions are preserved as provenance; comparing different analyzer providers is allowed when the comparison conditions match.

Each comparable finding must supply `details.assertion: {key, value}` and a capability. Matching requires both an exact assertion key and capability. Equal declared values produce `AGREEMENT`; different values produce `CONFLICT_CANDIDATE`. Missing peers are `ONE_SIDED`. Missing assertions or duplicate assertions for the same key/capability are `INCOMPARABLE`. Incompatible provenance produces top-level `MISMATCH` before any contradiction claim.

These are exporter assertions, not majority votes or adjudicated truth. There is no normalization that equates semantically different statements. The [W3C PROV primer](https://www.w3.org/TR/prov-primer/) provides the provenance motivation; this API is not a PROV serialization or independent attestation system.

## Verification

`node --test test/workbench-runtime-comparison.test.mjs`

The native fixture is `fixtures/workbench/runtime/chrome.json`. Tests cover supported and unsupported phases, microsecond units, source links, value/duration/order differences, missing/duplicate alignment, clock incompatibility, engine/config/snapshot isolation, explicit observation reasons, tampered imports, unknown coverage, bounds, traversal, inert script-like text and input immutability.

### Existing Fabric observations

`compareFabricObservations(leftObservations, rightObservations, {leftContext, rightContext})` accepts existing Fabric observations and requires complete import contexts for both sides. Every observation is normalized using the existing Fabric contract; any supplied per-observation engine/repository/snapshot/config/scope conflicting with its side's context fails closed. Missing per-observation collection fields are explicitly provided by the comparison context, not guessed. Full original normalized provider/version/provenance/source-range evidence is retained in `details.fabric_observation`.

An explicit `provider_payload.assertion: {key, value}` takes precedence. Otherwise an observation with an explicit `object` becomes a statement keyed by capability, observation type, subject and source file, with the object as its value. No object means no assertion. Different target objects can be compatible multi-valued facts, so a conflict candidate still needs human semantic review; duplicate statement keys remain incomparable. A missing edge or observation never creates a negative assertion.
