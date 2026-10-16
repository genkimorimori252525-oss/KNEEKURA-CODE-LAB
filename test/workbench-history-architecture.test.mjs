import test from "node:test";
import assert from "node:assert/strict";
import {
  importCodeMaat,
  analyzeCochangeHistory,
} from "../src/analyzer-fabric/imports/code-maat.mjs";
import {
  importArchUnit,
  compareArchUnitBaseline,
} from "../src/analyzer-fabric/imports/archunit.mjs";
const ctx = {
  repository_id: "repo",
  snapshot_id: "s1",
  analyzer_version: "1",
  config_digest: "cfg",
  scope_digest: "scope",
  engine_id: "kneekura",
};
const csv =
  'entity,coupled,degree,average-revs,note\r\n"src/a,b.js",src/c.js,75,4.5,"a ""quoted"" note"\r\n';
const arch = (ids = ["old"], complete = true) => ({
  schema: "kneekura.archunit.v1",
  baseline_id: "baseline-1",
  complete,
  rules: [
    {
      id: "layer",
      description: "No cycles",
      violations: ids.map((id) => ({
        id,
        description: id,
        sources: [{ path: "src/A.java", start_line: 4 }],
      })),
    },
  ],
});
test("imports native coupling CSV without inventing sample counts", () => {
  const r = importCodeMaat(csv, ctx);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.sources[0].path, "src/a,b.js");
  assert.equal(f.details.degree_percent, 75);
  assert.equal(f.details.average_revisions, 4.5);
  assert.equal(f.details.sample_count, null);
  assert.equal(f.strength, "HEURISTIC");
});
test("rejects malformed CSV numbers, paths, quoting and bounded input", () => {
  for (const bad of [
    csv.replace("75,", "101,"),
    csv.replace("75,", "NaN,"),
    csv.replace("src/c.js", "../c.js"),
    csv + '"unterminated',
  ])
    assert.throws(() => importCodeMaat(bad, ctx));
  assert.throws(() => importCodeMaat("x".repeat(8 * 1024 * 1024 + 1), ctx));
});
test("history counts exact sample IDs and applies explicit filters without mutating input", () => {
  const a = {
    schema: "kneekura.history.v1",
    commits: [
      { id: "1", files: ["a", "b"] },
      { id: "2", files: ["a", "b", "c"], merge: true },
      { id: "3", files: ["a", "b"], format_only: true },
      { id: "4", files: ["a", "b"] },
    ],
  };
  const copy = JSON.stringify(a);
  const r = analyzeCochangeHistory(a, ctx, {
    exclude_merges: true,
    exclude_format_only: true,
    min_samples: 2,
  });
  const f = r.findings.find((f) => f.kind === "cochange");
  assert.deepEqual(f.details.sample_ids, ["1", "4"]);
  assert.equal(f.details.sample_count, 2);
  assert.equal(f.details.degree_percent, 100);
  assert.equal(JSON.stringify(a), copy);
  assert.throws(() =>
    analyzeCochangeHistory(a, ctx, { max_pairs: 1, exclude_merges: false }),
  );
  assert.throws(() =>
    analyzeCochangeHistory(
      { ...a, commits: [a.commits[0], a.commits[0]] },
      ctx,
    ),
  );
});
test("architecture explicitly imports custom envelope and compares compatible snapshots", () => {
  const b = importArchUnit(arch(), ctx);
  const c = importArchUnit(arch(["old", "new"]), { ...ctx, snapshot_id: "s2" });
  const r = compareArchUnitBaseline(b, c);
  assert.equal(r.comparable, true);
  assert.deepEqual(r.findings.map((f) => f.status).sort(), ["existing", "new"]);
  assert.equal(
    compareArchUnitBaseline(c, b).findings.find((f) => f.violation_id === "new")
      .status,
    "resolved",
  );
  assert.throws(() => importArchUnit({ rules: [] }, ctx));
});
test("architecture baseline mismatches and incomplete exports never resolve violations", () => {
  const b = importArchUnit(arch(), ctx);
  for (const field of [
    "repository_id",
    "config_digest",
    "scope_digest",
    "engine_id",
  ])
    assert.equal(
      compareArchUnitBaseline(
        b,
        importArchUnit(arch([]), {
          ...ctx,
          [field]: field === "engine_id" ? "archify" : "different",
        }),
      ).comparable,
      false,
    );
  const incomplete = compareArchUnitBaseline(
    b,
    importArchUnit(arch([], false), ctx),
  );
  assert.equal(incomplete.comparable, false);
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.findings, []);
  assert.throws(() =>
    importArchUnit(
      { ...arch(), rules: [...arch().rules, ...arch().rules] },
      ctx,
    ),
  );
  assert.throws(() =>
    importArchUnit(
      {
        ...arch(),
        rules: [
          {
            ...arch().rules[0],
            violations: [
              { id: "x", description: "bad", sources: [{ path: "../secret" }] },
            ],
          },
        ],
      },
      ctx,
    ),
  );
});
test("baseline comparison rejects modified imported results", () => {
  const b = importArchUnit(arch(), ctx);
  const forged = structuredClone(b);
  forged.findings[0].details.complete = false;
  assert.throws(() => compareArchUnitBaseline(forged, b), /digest/);
});
test("history and architecture imports are deterministic and freeze only outputs", () => {
  const input = arch();
  const copy = JSON.stringify(input);
  const first = importArchUnit(input, ctx);
  assert.deepEqual(first, importArchUnit(input, ctx));
  assert.equal(JSON.stringify(input), copy);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(first), true);
  const changed = arch();
  changed.rules[0].description = "changed rule";
  assert.equal(
    compareArchUnitBaseline(first, importArchUnit(changed, ctx)).comparable,
    false,
  );
  const other = arch();
  other.baseline_id = "different";
  assert.equal(
    compareArchUnitBaseline(first, importArchUnit(other, ctx)).comparable,
    false,
  );
});
test("history rejects expanded sample evidence beyond byte budget", () => {
  const commits = [
    {
      id: "x".repeat(2000),
      files: Array.from({ length: 100 }, (_, i) => `src/${i}.java`),
    },
  ];
  assert.throws(
    () =>
      analyzeCochangeHistory({ schema: "kneekura.history.v1", commits }, ctx, {
        min_samples: 1,
      }),
    /sample evidence byte limit/,
  );
});
test("history rejects expanded pair path evidence beyond byte budget", () => {
  const commits = [
    {
      id: "sample",
      files: Array.from(
        { length: 100 },
        (_, i) => `src/${"x".repeat(2000)}${i}.java`,
      ),
    },
  ];
  assert.throws(
    () =>
      analyzeCochangeHistory({ schema: "kneekura.history.v1", commits }, ctx, {
        min_samples: 1,
      }),
    /pair evidence byte limit/,
  );
});
