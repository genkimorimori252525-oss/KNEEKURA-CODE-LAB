import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const context = {
  repository_id: "repo",
  snapshot_id: "head",
  analyzer_version: "1",
  config_digest: "cfg",
  scope_digest: "scope",
  engine_id: "kneekura",
};
const load = (name) =>
  readFile(
    new URL(`../fixtures/workbench/static/${name}`, import.meta.url),
    "utf8",
  );
test("RefactoringMiner retains both snapshot sides without asserting equivalence", async () => {
  const { importRefactoringMiner } = await import(
    "../src/analyzer-fabric/imports/refactoring-miner.mjs"
  );
  const result = importRefactoringMiner(
    await load("refactoring-miner.json"),
    context,
    { base_snapshot_id: "base" },
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sources[0].snapshot_id, "base");
  assert.equal(result.findings[0].sources[1].snapshot_id, "head");
  assert.equal(result.findings[0].details.category, "rename");
  assert.throws(
    () => importRefactoringMiner(awaitNothing(), context),
    /base_snapshot_id/,
  );
  function awaitNothing() {
    return { commits: [] };
  }
});
test("CPD retains duplicate occurrences but excludes root file inventory", async () => {
  const { importCpd, annotateCloneGroups } = await import(
    "../src/analyzer-fabric/imports/pmd-cpd.mjs"
  );
  const result = importCpd(await load("cpd.xml"), context);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sources.length, 2);
  assert.equal(result.findings[0].details.tokens, 40);
  assert.equal(
    result.findings[0].details.code_fragment,
    "if (a < b) return a;",
  );
  const annotated = annotateCloneGroups(result, [
    {
      finding_id: result.findings[0].id,
      label: "intentional",
      note: "independent examples",
    },
  ]);
  assert.equal(annotated.annotations[0].authority, "HUMAN_ANNOTATION");
  assert.equal(result.annotations, undefined);
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><pmd-cpd/>',
    '<pmd-cpd><duplication lines="2" tokens="4"><file path="../bad" line="1"/></duplication></pmd-cpd>',
    "<pmd-cpd><duplication></pmd-cpd>",
  ])
    assert.throws(() => importCpd(xml, context));
});
test("AST mappings preserve native offsets separately from action text", async () => {
  const { importRefactoringMinerAst } = await import(
    "../src/analyzer-fabric/imports/refactoring-miner.mjs"
  );
  const mapping = JSON.parse(await load("refactoring-miner-ast-mappings.json"));
  const result = importRefactoringMinerAst(mapping, context, {
    base_snapshot_id: "base",
    srcPath: "src/A.java",
    dstPath: "src/B.java",
    actionText: "update-node\nSimpleName",
  });
  assert.equal(result.findings[0].details.mapping.firstPos, 10);
  assert.equal(result.findings[0].sources[0].start_line, undefined);
  assert.ok(result.findings.some((f) => f.kind === "ast-action-text"));
  assert.throws(
    () =>
      importRefactoringMinerAst(mapping, context, { base_snapshot_id: "base" }),
    /path|srcPath/i,
  );
});
test("Joern imports source locations and bounded backwards static reachability", async () => {
  const { importJoernSlice, queryJoernBackwardSlice } = await import(
    "../src/analyzer-fabric/imports/joern.mjs"
  );
  const result = importJoernSlice(await load("joern-dataflow.json"), context);
  const slice = queryJoernBackwardSlice(result, {
    sinkId: 2,
    maxDepth: 2,
    maxNodes: 5,
  });
  assert.equal(slice.nodes.length, 2);
  assert.equal(slice.nodes[1].id, "9007199254740993");
  assert.equal(slice.observed_execution, false);
  assert.equal(
    queryJoernBackwardSlice(result, { sinkId: 2, maxDepth: 0, maxNodes: 5 })
      .truncated,
    true,
  );
  assert.throws(
    () => queryJoernBackwardSlice(result, { sinkId: 2, maxDepth: 999999 }),
    /bound|depth/i,
  );
  assert.throws(
    () =>
      importJoernSlice(
        { nodes: [], edges: [{ src: 1, dst: 2, label: "DDG" }] },
        context,
      ),
    /node|endpoint/i,
  );
});
test("Joern usage import accepts exporter encoded DefComponents and field-scoped optional arrays", async () => {
  const { importJoernSlice } = await import(
    "../src/analyzer-fabric/imports/joern.mjs"
  );
  const raw = JSON.parse(await load("joern-usages.json"));
  const original = JSON.stringify(raw),
    result = importJoernSlice(raw, context);
  assert.equal(result.findings[0].details.slices[0].targetObj.name, "x");
  assert.equal(
    result.findings[0].details.slices[0].argToCalls[0].lineNumber,
    3,
  );
  assert.equal(JSON.stringify(raw), original);
});
test("Static importers reject identity conflicts, unsafe paths, oversized graphs and forged results", async () => {
  const { importRefactoringMiner, importRefactoringMinerAst } = await import(
    "../src/analyzer-fabric/imports/refactoring-miner.mjs"
  );
  const { importJoernSlice, queryJoernBackwardSlice } = await import(
    "../src/analyzer-fabric/imports/joern.mjs"
  );
  const { importCpd, annotateCloneGroups } = await import(
    "../src/analyzer-fabric/imports/pmd-cpd.mjs"
  );
  const rm = JSON.parse(await load("refactoring-miner.json"));
  assert.throws(
    () =>
      importRefactoringMiner(rm, context, {
        base_snapshot_id: "base",
        head_snapshot_id: "wrong",
      }),
    /snapshot/,
  );
  assert.throws(
    () =>
      importRefactoringMiner(rm, context, {
        base_snapshot_id: "base",
        head_commit: "wrong",
      }),
    /commit/,
  );
  rm.commits[0].refactorings[0].leftSideLocations[0].filePath = "../secret";
  assert.throws(
    () => importRefactoringMiner(rm, context, { base_snapshot_id: "base" }),
    /path/,
  );
  assert.throws(
    () =>
      importRefactoringMinerAst([], context, {
        base_snapshot_id: "base",
        srcPath: "/etc/passwd",
        dstPath: "A.java",
      }),
    /path/,
  );
  assert.throws(
    () => importJoernSlice({ nodes: Array(1001).fill({}), edges: [] }, context),
    /limit/,
  );
  assert.throws(
    () =>
      importJoernSlice(
        {
          nodes: [{ id: 9007199254740992, label: "CALL", code: "x" }],
          edges: [],
        },
        context,
      ),
    /unsafe/,
  );
  const result = importJoernSlice(await load("joern-dataflow.json"), context);
  const forged = structuredClone(result);
  forged.findings[0].details.edges = [];
  assert.throws(() => queryJoernBackwardSlice(forged, { sinkId: 2 }), /digest/);
  const clone = importCpd(await load("cpd.xml"), context);
  assert.throws(
    () =>
      annotateCloneGroups(clone, [
        { finding_id: "fake", label: "x", note: "x" },
      ]),
    /Unknown/,
  );
  assert.throws(
    () =>
      importCpd(
        "<pmd-cpd>" + " ".repeat(8 * 1024 * 1024) + "</pmd-cpd>",
        context,
      ),
    /byte/,
  );
});
test("Static imports are deterministic, freeze outputs and leave inputs unchanged", async () => {
  const { importRefactoringMiner } = await import(
    "../src/analyzer-fabric/imports/refactoring-miner.mjs"
  );
  const input = JSON.parse(await load("refactoring-miner.json")),
    before = JSON.stringify(input);
  const options = { base_snapshot_id: "base" };
  const a = importRefactoringMiner(input, context, options),
    b = importRefactoringMiner(input, context, options);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(a.findings[0].details.locations.before));
  assert.equal(a.observations.length, a.findings.length);
  assert.equal(a.authority.canonical_graph_mutated, false);
});
test("CPD rejects forged annotation imports and malformed XML attributes", async () => {
  const { importCpd, annotateCloneGroups } = await import(
    "../src/analyzer-fabric/imports/pmd-cpd.mjs"
  );
  assert.throws(
    () =>
      annotateCloneGroups(
        { adapter_id: "pmd-cpd", findings: [{ id: "fake" }] },
        [{ finding_id: "fake", label: "x", note: "x" }],
      ),
    /schema|digest/,
  );
  for (const xml of [
    '<pmd-cpd a="x" a="y"/>',
    "<pmd-cpd>&unknown;</pmd-cpd>",
    "<pmd-cpd/><pmd-cpd/>",
  ])
    assert.throws(() => importCpd(xml, context));
});
test("CPD accepts quoted XML delimiters and rejects forbidden control characters", async () => {
  const { importCpd } = await import(
    "../src/analyzer-fabric/imports/pmd-cpd.mjs"
  );
  const xml =
    '<pmd-cpd><duplication lines="1" tokens="4"><file path="a>b.java" line="1"/><file path="b.java" line="2"/><codefragment>x &lt; y &amp;&amp; y &gt; z</codefragment></duplication></pmd-cpd>';
  assert.equal(importCpd(xml, context).findings[0].sources[0].path, "a>b.java");
  assert.throws(
    () => importCpd(xml.replace("x &lt;", "\u0001 &lt;"), context),
    /character/,
  );
});
