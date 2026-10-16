import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importChromeTrace } from "../src/analyzer-fabric/imports/chrome-trace.mjs";
import { compareSavedRuns } from "../src/analysis-workbench/run-comparison.mjs";
import { classifyObservationReason } from "../src/analysis-workbench/observation-reasons.mjs";
import { createImportResult } from "../src/analysis-workbench/contracts.mjs";
import { compareAnalyzerFindings } from "../src/analysis-workbench/disagreement.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/workbench/runtime/chrome.json", import.meta.url),
    "utf8",
  ),
);
const context = {
  repository_id: "repo",
  snapshot_id: "snapshot",
  analyzer_version: "1",
  config_digest: "cfg",
  scope_digest: "scope",
  engine_id: "kneekura",
  run_id: "run-a",
};
const imported = (artifact = fixture, ctx = context) =>
  importChromeTrace(artifact, ctx);
const altered = (fn) => {
  const data = structuredClone(fixture);
  fn(data);
  return imported(data, { ...context, run_id: "run-b" });
};
test("imports complete/instant native events with microsecond units and explicit evidence", () => {
  const before = JSON.stringify(fixture),
    result = imported();
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].details.time_unit, "us");
  assert.equal(result.findings[0].details.duration, 20);
  assert.equal(result.findings[0].sources[0].path, "src/shop.mjs");
  assert.equal(result.findings[0].details.canonical_id, "fn:checkout");
  assert.ok(result.warnings.length);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(imported(fixture.traceEvents).findings.length, 2);
});
test("saved runs report first observed value or duration difference without time guessing", () => {
  const result = compareSavedRuns(
    imported(),
    altered((x) => {
      x.traceEvents[0].args.value = 43;
      x.traceEvents[0].dur = 21;
    }),
  );
  assert.equal(result.status, "DIFFERENCES");
  assert.equal(result.aligned.length, 2);
  assert.equal(result.first_difference.fields[0], "value");
  assert.equal(result.first_difference.left.sources[0].path, "src/shop.mjs");
  assert.equal(
    compareSavedRuns(imported(), imported()).status,
    "NO_OBSERVED_DIFFERENCE",
  );
});
test("duplicates, missing anchors and changed ordering never guess alignment", () => {
  assert.ok(
    compareSavedRuns(
      imported(),
      altered((x) => x.traceEvents.push(structuredClone(x.traceEvents[0]))),
    ).unaligned.some((x) => x.reason === "DUPLICATE_ANCHOR"),
  );
  assert.ok(
    compareSavedRuns(
      imported(),
      altered((x) => delete x.traceEvents[0].args.operation_id),
    ).unaligned.some((x) => x.reason === "MISSING_ANCHOR"),
  );
  assert.equal(
    compareSavedRuns(
      imported(),
      altered((x) => x.traceEvents.reverse()),
    ).first_difference.fields[0],
    "order",
  );
});
test("clock or engine mismatch stays unknown and comparisons never mutate imports", () => {
  const left = imported(),
    before = JSON.stringify(left);
  assert.equal(
    compareSavedRuns(
      left,
      altered((x) => (x.traceEvents[0].args.clock_scope = "wall")),
    ).aligned[0].status,
    "UNKNOWN",
  );
  assert.equal(
    compareSavedRuns(
      left,
      imported(fixture, { ...context, engine_id: "archify" }),
    ).status,
    "MISMATCH",
  );
  assert.equal(JSON.stringify(left), before);
});
test("observation reasons require explicit declarations and never claim nonexecution", () => {
  assert.equal(classifyObservationReason().reason, "UNKNOWN");
  assert.equal(
    classifyObservationReason({ observed: false }).reason,
    "UNKNOWN",
  );
  assert.equal(
    classifyObservationReason({ instrumented: false }).reason,
    "NOT_INSTRUMENTED",
  );
  assert.equal(
    classifyObservationReason({ sampled_out: true }).reason,
    "SAMPLED_OR_DROPPED",
  );
  assert.equal(
    classifyObservationReason({ dropped_count: 2 }).reason,
    "SAMPLED_OR_DROPPED",
  );
  assert.equal(
    classifyObservationReason({ identity_match: false }).reason,
    "IDENTITY_MISMATCH",
  );
  assert.equal(
    classifyObservationReason({ instrumented: false }).execution,
    "UNKNOWN",
  );
});
test("malformed, unsafe, oversized and deep traces fail closed", () => {
  assert.throws(() => imported("{"));
  assert.throws(() => imported({}));
  for (const change of [
    (x) => (x.traceEvents[0].ts = "1"),
    (x) => (x.traceEvents[0].dur = -1),
    (x) => (x.traceEvents[0].args.source.path = "../secret"),
    (x) => (x.traceEvents[0].name = "a".repeat(17000)),
  ])
    assert.throws(() => altered(change));
  assert.throws(() => imported(Array(10001).fill(fixture.traceEvents[0])));
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  assert.throws(() => imported({ traceEvents: [], deep }));
  const injected = altered(
    (x) => (x.traceEvents[0].name = "<script>alert(1)</script>"),
  );
  assert.equal(injected.findings[0].title, "<script>alert(1)</script>");
});
const evidence = (value, ctx = context, findings) =>
  createImportResult(
    "declared",
    {},
    ctx,
    findings ?? [
      {
        kind: "assertion",
        title: "Result assertion",
        capability: "RUNTIME",
        sources: [],
        details: { assertion: { key: "checkout.result", value } },
      },
    ],
  );
test("disagreements are candidates only under exact conditions and explicit assertions", () => {
  assert.equal(
    compareAnalyzerFindings(evidence(true), evidence(false)).comparisons[0]
      .status,
    "CONFLICT_CANDIDATE",
  );
  assert.equal(
    compareAnalyzerFindings(evidence(true), evidence(true)).comparisons[0]
      .status,
    "AGREEMENT",
  );
  assert.equal(
    compareAnalyzerFindings(evidence(true), evidence(false, context, []))
      .comparisons[0].status,
    "ONE_SIDED",
  );
  assert.equal(
    compareAnalyzerFindings(imported(), imported()).comparisons[0].status,
    "INCOMPARABLE",
  );
  const other = imported(fixture, { ...context, config_digest: "other" });
  assert.equal(
    compareAnalyzerFindings(evidence(true), other).status,
    "MISMATCH",
  );
});

test("comparison APIs reject tampered imports and preserve distinct capabilities", () => {
  const tampered = structuredClone(imported());
  tampered.context.engine_id = "archify";
  assert.throws(() => compareSavedRuns(imported(), tampered));
  assert.throws(() => compareAnalyzerFindings(imported(), tampered));
  const other = evidence(false, context, [
    {
      kind: "assertion",
      title: "Static",
      capability: "SYNTAX",
      sources: [],
      details: { assertion: { key: "checkout.result", value: false } },
    },
  ]);
  assert.ok(
    compareAnalyzerFindings(evidence(true), other).comparisons.every(
      (x) => x.status === "ONE_SIDED",
    ),
  );
  for (const field of [
    "repository_id",
    "snapshot_id",
    "config_digest",
    "scope_digest",
    "engine_id",
  ]) {
    const ctx = {
      ...context,
      [field]: field === "engine_id" ? "archify" : "different",
    };
    assert.equal(
      compareAnalyzerFindings(evidence(true), evidence(false, ctx)).status,
      "MISMATCH",
    );
  }
});
test("missing clock, one-sided events and empty recordings stay unknown", () => {
  assert.equal(
    compareSavedRuns(
      imported(),
      altered((x) => delete x.traceEvents[0].args.clock_scope),
    ).status,
    "UNKNOWN",
  );
  assert.equal(compareSavedRuns(imported([]), imported([])).status, "UNKNOWN");
  assert.ok(
    compareSavedRuns(imported(), imported([])).unaligned.every(
      (x) => x.reason === "ONE_SIDED",
    ),
  );
  assert.throws(() =>
    altered((x) => (x.traceEvents[0].args.source.snapshot_id = "wrong")),
  );
  assert.equal(
    compareSavedRuns(
      imported(),
      altered((x) => (x.traceEvents[0].ts = 999)),
    ).status,
    "NO_OBSERVED_DIFFERENCE",
  );
});

test("existing Fabric observations compare explicit object statements with preserved provenance", async () => {
  const { compareFabricObservations } = await import(
    "../src/analysis-workbench/disagreement.mjs"
  );
  const { normalizeAnalyzerObservation } = await import(
    "../src/analyzer-fabric/observation.mjs"
  );
  const observation = (value) =>
    normalizeAnalyzerObservation({
      provider_id: "instrumentation",
      provider_version: "1",
      capability: "RUNTIME",
      strength: "RUNTIME_OBSERVED",
      origin: "RUNTIME",
      observation_type: "return-value",
      subject: { symbol: "checkout" },
      object: { value },
      snapshot: { repository_id: "repo", snapshot_id: "snapshot" },
      provenance: { ...context },
      source_file: "src/shop.mjs",
    });
  const left = observation(true),
    right = observation(false),
    before = JSON.stringify(left);
  const result = compareFabricObservations([left], [right], {
    leftContext: context,
    rightContext: context,
  });
  assert.equal(result.comparisons[0].status, "CONFLICT_CANDIDATE");
  assert.equal(
    result.comparisons[0].left[0].details.fabric_observation.provider_id,
    "instrumentation",
  );
  assert.equal(JSON.stringify(left), before);
  assert.throws(() => compareFabricObservations([left], [right], {}));
  assert.throws(() =>
    compareFabricObservations([left], [right], {
      leftContext: context,
      rightContext: { ...context, scope_digest: "wrong" },
    }),
  );
  const missing = structuredClone(left);
  delete missing.object;
  assert.ok(
    compareFabricObservations([missing], [], {
      leftContext: context,
      rightContext: context,
    }).comparisons.every((x) => x.status === "INCOMPARABLE"),
  );
});

test("one-sided missing events do not invent an order change among aligned observations", () => {
  const c = {
    repository_id: "repo:r",
    snapshot_id: "snap:a",
    analyzer_version: "1",
    config_digest: "c",
    scope_digest: "s",
    engine_id: "kneekura",
  };
  const event = (id) => ({
    ph: "X",
    name: id,
    ts: 1,
    dur: 1,
    args: { operation_id: "op", correlation_id: id, clock_scope: "p" },
  });
  const a = importChromeTrace(
    { traceEvents: [event("missing"), event("same")] },
    c,
  );
  const b = importChromeTrace({ traceEvents: [event("same")] }, c);
  const result = compareSavedRuns(a, b);
  assert.equal(result.first_difference, null);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.unaligned[0].reason, "ONE_SIDED");
});
