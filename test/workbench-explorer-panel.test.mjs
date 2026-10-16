import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rolldown } from "rolldown";

const root = path.resolve(import.meta.dirname, "..");
let panel;
// Compile the actual JSX, retaining the application's React runtime.
test.before(async () => {
  const entry = path.join(
    root,
    "packages/human-explorer/src/WorkbenchPanel.jsx",
  );
  assert.ok(
    await fs.stat(entry).catch(() => null),
    "WorkbenchPanel must exist",
  );
  const directory = await fs.mkdtemp(path.join(root, ".workbench-panel-test-"));
  try {
    const bundle = await rolldown({
      input: entry,
      external: (id) => id === "react" || id.startsWith("react/"),
    });
    try {
      await bundle.write({
        file: path.join(directory, "panel.mjs"),
        format: "esm",
      });
    } finally {
      await bundle.close();
    }
    panel = await import(pathToFileURL(path.join(directory, "panel.mjs")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
const source = {
  path: "src/<script>.java",
  snapshot_id: "snapshot-head",
  start_line: 12,
};
const finding = {
  id: "f1",
  kind: "refactoring",
  title: "<script>alert(1)</script>",
  sources: [source],
  details: {
    category: "rename",
    before: [{ ...source, snapshot_id: "snapshot-base" }],
    after: [source],
    observation_metadata: { instrumented: false, sampled_out: true },
  },
};
const workbench = {
  schema: "kneekura.explorer-workbench-panel/v1",
  report_id: "r1",
  findings: [finding],
  links: [
    { finding_id: "f1", ...source, status: "MATCH", node_ids: ["node-1"] },
  ],
  warnings: [],
};
function render(value = workbench) {
  return renderToStaticMarkup(
    React.createElement(panel.WorkbenchPanel, {
      workbench: value,
      onSelectNode: () => {},
    }),
  );
}

test("actual panel renders inert imported evidence, snapshots, semantic category and collection reasons", () => {
  const before = JSON.stringify(workbench);
  const html = render();
  for (const text of [
    "IMPORTED / DERIVED",
    "canonical",
    "snapshot-head",
    "snapshot-base",
    "rename",
    "Before",
    "After",
    "NOT_INSTRUMENTED",
    "SAMPLED_OR_DROPPED",
    "MATCH",
    "node-1",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.equal(JSON.stringify(workbench), before);
});
test("only an exact single-node MATCH can trigger navigation", () => {
  const calls = [];
  const callback = (id) => calls.push(id);
  assert.equal(
    panel.activateWorkbenchLink(workbench.links[0], "node-1", callback),
    true,
  );
  for (const status of [
    "AMBIGUOUS",
    "OTHER_SNAPSHOT",
    "UNRESOLVED_SOURCE",
    "UNRESOLVED_IDENTITY",
  ]) {
    assert.equal(
      panel.activateWorkbenchLink(
        { ...workbench.links[0], status },
        "node-1",
        callback,
      ),
      false,
    );
    assert.ok(
      render({
        ...workbench,
        links: [{ ...workbench.links[0], status, node_ids: [] }],
      }).includes(status),
    );
  }
  assert.equal(
    panel.activateWorkbenchLink(workbench.links[0], "other", callback),
    false,
  );
  assert.equal(
    panel.activateWorkbenchLink(
      { ...workbench.links[0], node_ids: ["node-1", "node-2"] },
      "node-1",
      callback,
    ),
    false,
  );
  assert.deepEqual(calls, ["node-1"]);
});
test("initial render bounds findings and provides explicit paging", () => {
  const html = render({
    ...workbench,
    findings: Array.from({ length: 101 }, (_, i) => ({
      ...finding,
      id: `f${i}`,
      title: `Finding-${i}-end`,
    })),
  });
  assert.ok(html.includes("Finding-99-end"));
  assert.ok(!html.includes("Finding-100-end"));
  assert.ok(html.includes("次の100件"));
});
test("missing metadata stays unavailable and unknown schemas do not render", () => {
  assert.equal(render(null), "");
  assert.equal(render({ ...workbench, schema: "untrusted" }), "");
  const html = render({
    ...workbench,
    findings: [
      {
        id: "empty",
        kind: "runtime",
        title: "No sources",
        sources: [],
        details: { observation_metadata: { observed: false } },
      },
    ],
    links: [],
  });
  assert.ok(html.includes("UNKNOWN"));
  assert.ok(html.includes("ソース参照なし"));
});
test("Explorer mounts the panel and bridges exact links into the existing focus/impact selection", async () => {
  const app = await fs.readFile(
    path.join(root, "packages/human-explorer/src/App.jsx"),
    "utf8",
  );
  assert.match(app, /<WorkbenchPanel/);
  assert.match(app, /workbench=\{projection\.presentation\?\.workbench\}/);
  assert.match(app, /onSelectNode=\{focusWorkbenchNode\}/);
  assert.match(app, /focusNode\(pendingWorkbenchNodeId\)/);
});
