import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runEvidenceWorkbench,
  describeEvidenceWorkbench,
} from "../src/analysis-workbench/index.mjs";
import {
  compileWorkbenchArtifact,
  projectWorkbenchForAgent,
} from "../src/analysis-workbench/render.mjs";
import { createKneekuraCodeLabMcpAdapter } from "../mcp/src/adapter.mjs";
const context = {
  repository_id: "repo:r",
  snapshot_id: "snapshot:new",
  analyzer_version: "3.1.4",
  config_digest: "sha256:c",
  scope_digest: "sha256:s",
  engine_id: "kneekura",
};
function request() {
  return {
    operation: "import",
    adapter: "refactoring-miner",
    context,
    options: { base_snapshot_id: "snapshot:old", head_commit: "123" },
    artifact: {
      commits: [
        {
          sha1: "123",
          refactorings: [
            {
              type: "Rename Method",
              description: "Rename <script>old</script> to new",
              leftSideLocations: [
                { filePath: "src/A.java", startLine: 2, endLine: 4 },
              ],
              rightSideLocations: [
                { filePath: "src/A.java", startLine: 2, endLine: 4 },
              ],
            },
          ],
        },
      ],
    },
  };
}
function projection() {
  const nodes = [
    {
      id: "changed",
      kind: "method",
      key: "changed",
      label: "new",
      file: "src/A.java",
      line: 2,
    },
    { id: "caller", kind: "method", key: "caller", label: "caller" },
  ];
  const edges = [
    {
      id: "calls",
      from: "caller",
      to: "changed",
      type: "CALLS",
      confidence: 1,
    },
  ];
  return {
    schema: "kneekura.explorer-projection/v1",
    source: {
      repository_id: context.repository_id,
      graph_repository_id: context.repository_id,
      snapshot_id: context.snapshot_id,
      graph_snapshot_id: context.snapshot_id,
    },
    canonical: {
      graph: { schema: "kneekura.graph/v1", nodes, edges },
      result: { schema: "core.analysis-result/v1", status: "COMPLETE" },
    },
    presentation: {
      nodes: nodes.map((n, i) => ({
        node_id: n.id,
        canonical_index: i,
        canonical_kind: n.kind,
        display_family: "source",
        label: n.label,
      })),
      edges: edges.map((e, i) => ({
        edge_id: e.id,
        canonical_index: i,
        from_node_id: e.from,
        to_node_id: e.to,
        canonical_type: e.type,
      })),
      claims: [],
      coverage: [],
    },
  };
}
test("import to Fabric to exact Explorer links and semantic impact leaves graph unchanged", () => {
  const p = projection(),
    before = JSON.stringify(p);
  const report = runEvidenceWorkbench({ ...request(), projection: p });
  assert.equal(report.result.observations.length, 1);
  assert.equal(
    report.projection.links.find((x) => x.snapshot_id === "snapshot:new")
      .status,
    "MATCH",
  );
  const impact = runEvidenceWorkbench({
    operation: "semantic-impact",
    imported: report.result,
    projection: p,
    finding_id: report.result.findings[0].id,
  });
  assert.deepEqual(impact.result.impacts[0].selected_node_ids, [
    "caller",
    "changed",
  ]);
  assert.equal(JSON.stringify(p), before);
  const unknown = projection();
  delete unknown.source.graph_snapshot_id;
  assert.equal(
    runEvidenceWorkbench({ ...request(), projection: unknown }).projection
      .links[0].status,
    "UNRESOLVED_IDENTITY",
  );
});
test("human bundle and compact agent rendering are distinct safe projections", () => {
  const report = runEvidenceWorkbench(request());
  const artifact = compileWorkbenchArtifact(report);
  assert.ok(artifact.index_html.includes("&lt;script&gt;"));
  assert.ok(!artifact.index_html.includes("<script>old</script>"));
  assert.ok(artifact.index_html.includes("snapshot:old"));
  assert.ok(artifact.zip_bytes.length > 0);
  const agent = projectWorkbenchForAgent(report, { limit: 1 });
  assert.equal(agent.instruction_authority, false);
  assert.equal(agent.items.length, 1);
  assert.ok(!JSON.stringify(agent).includes("provider_payload"));
});
test("existing MCP adapter discovers and invokes bounded import-only workbench", () => {
  const a = createKneekuraCodeLabMcpAdapter();
  assert.ok(a.describe().tools.includes("kneekura_code_lab_workbench"));
  const result = a.workbench(request());
  assert.equal(result.schema, "kneekura.evidence-workbench-agent/v1");
  assert.equal(result.total_items, 1);
  assert.ok(describeEvidenceWorkbench().adapters.includes("pmd-cpd"));
});
test("CLI emits offline HTML ZIP and machine output, refuses existing output", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-"));
  try {
    const file = path.join(tmp, "request.json"),
      out = path.join(tmp, "out");
    await fs.writeFile(file, JSON.stringify(request()));
    execFileSync(process.execPath, [
      "src/cli.mjs",
      "workbench",
      "--request",
      file,
      "--out",
      out,
    ]);
    for (const name of [
      "index.html",
      "bundle.zip",
      "report.json",
      "agent.json",
      "agent.md",
      "manifest.json",
    ])
      assert.ok((await fs.stat(path.join(out, name))).size > 0);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["src/cli.mjs", "workbench", "--request", file, "--out", out],
        { stdio: "pipe" },
      ),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("MCP composes imports into comparisons and bounded exact detail access", () => {
  const adapter = createKneekuraCodeLabMcpAdapter();
  const left = {
    operation: "import",
    adapter: "chrome-trace",
    context,
    artifact: {
      traceEvents: [
        {
          ph: "X",
          name: "run",
          ts: 10,
          dur: 2,
          args: {
            operation_id: "op",
            correlation_id: "one",
            clock_scope: "process",
            value: 1,
          },
        },
      ],
    },
  };
  const right = structuredClone(left);
  right.artifact.traceEvents[0].args.value = 2;
  const result = adapter.workbench({ operation: "compare-runs", left, right });
  assert.equal(result.status, "DIFFERENCES");
  assert.ok(result.metadata.first_difference);
  assert.ok(result.items[0].evidence.fields.includes("value"));
  const exact = adapter.workbench(
    { operation: "compare-runs", left, right },
    { pointer: "/result/first_difference/fields" },
  );
  assert.equal(exact.items[0].value, "value");
  const coupling = {
    operation: "import",
    adapter: "code-maat",
    context: {
      ...context,
      repository_id: "r".repeat(16000),
      snapshot_id: "s".repeat(16000),
    },
    artifact:
      "entity,coupled,degree,average-revs\nsrc/A.java,src/B.java,78,44\n",
  };
  const small = adapter.workbench(coupling, { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 2048);
  assert.ok(small.truncated);
  const metric = adapter.workbench({ ...coupling, context });
  assert.equal(metric.items[0].evidence.degree_percent, 78);
  const reason = adapter.workbench({
    operation: "observation-reason",
    metadata: { instrumented: false, dropped_count: 2 },
  });
  assert.deepEqual(reason.metadata.reasons, [
    "NOT_INSTRUMENTED",
    "SAMPLED_OR_DROPPED",
  ]);
  assert.equal(reason.metadata.execution, "UNKNOWN");
});

test("Source Broker materializes matching digest-bound source and rejects drift", async () => {
  const { createHumanAnalysisEvidencePack } = await import(
    "../src/human-analysis/evidence-pack.mjs"
  );
  const { createHash } = await import("node:crypto");
  const { materializeWorkbenchSources } = await import(
    "../src/analysis-workbench/index.mjs"
  );
  const source = "class A {\n void run() {\n call();\n }\n}";
  const digest = "sha256:" + createHash("sha256").update(source).digest("hex");
  const pack = createHumanAnalysisEvidencePack({
    repository: { repository_id: context.repository_id },
    snapshot: { snapshot_id: context.snapshot_id },
    source_catalog: [
      { path: "src/A.java", content_digest: digest, line_count: 5 },
    ],
  });
  const basePack = createHumanAnalysisEvidencePack({
    repository: { repository_id: context.repository_id },
    snapshot: { snapshot_id: "snapshot:old" },
    source_catalog: [
      { path: "src/A.java", content_digest: digest, line_count: 5 },
    ],
  });
  const report = runEvidenceWorkbench(request());
  const both = await materializeWorkbenchSources(report, {
    bindings: [
      { evidencePack: pack, readSource: async () => source },
      { evidencePack: basePack, readSource: async () => source },
    ],
  });
  assert.equal(
    both.sources.filter((x) => x.status === "DIGEST_VERIFIED_SOURCE").length,
    2,
  );
  assert.deepEqual(both.sources.map((x) => x.snapshot_id).sort(), [
    "snapshot:new",
    "snapshot:old",
  ]);
  const enriched = await materializeWorkbenchSources(report, {
    bindings: [{ evidencePack: pack, readSource: async () => source }],
  });
  assert.equal(
    enriched.sources.find((x) => x.snapshot_id === context.snapshot_id).status,
    "DIGEST_VERIFIED_SOURCE",
  );
  assert.ok(
    compileWorkbenchArtifact(enriched).index_html.includes("3:  call();"),
  );
  await assert.rejects(
    () =>
      materializeWorkbenchSources(report, {
        bindings: [
          { evidencePack: pack, readSource: async () => source + "changed" },
        ],
      }),
    /digest mismatch/,
  );
});

test("attached Explorer projection is listed in manifest and included in ZIP", () => {
  const report = runEvidenceWorkbench({
    ...request(),
    projection: projection(),
  });
  const bundle = compileWorkbenchArtifact(report, {
    explorerProjection: projection(),
  });
  assert.ok(
    bundle.manifest.files.some((x) => x.path === "explorer-projection.json"),
  );
  assert.ok(bundle.zip_bytes.includes(Buffer.from("explorer-projection.json")));
});

test("composed native text artifacts use artifact byte budget rather than single-field limit", () => {
  const csv =
    "entity,coupled,degree,average-revs\n" +
    Array.from(
      { length: 500 },
      (_, i) =>
        `src/LongSourceName${i}.java,src/OtherSourceName${i}.java,50,10\n`,
    ).join("");
  assert.ok(csv.length > 16384);
  const report = runEvidenceWorkbench({
    operation: "import",
    adapter: "code-maat",
    context,
    artifact: csv,
  });
  assert.equal(report.result.findings.length, 500);
});
