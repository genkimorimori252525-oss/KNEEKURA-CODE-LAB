import test from "node:test";
import assert from "node:assert/strict";
import {
  createImportResult,
  parseJsonArtifact,
  safePath,
  validateImportResult,
} from "../src/analysis-workbench/contracts.mjs";
const context = {
  repository_id: "repo:r",
  snapshot_id: "snapshot:a",
  analyzer_version: "1",
  config_digest: "sha256:c",
  scope_digest: "sha256:s",
  engine_id: "kneekura",
};
test("imports preserve provenance, are deterministic and immutable Fabric observations", () => {
  const artifact = { ok: true };
  const findings = [
    {
      kind: "TEST",
      title: "test",
      sources: [{ path: "src/a.java", start_line: 2, end_line: 3 }],
      details: { value: 1 },
      capability: "SYNTAX",
      strength: "STRUCTURAL",
    },
  ];
  const result = createImportResult("test", artifact, context, findings, {
    format: "test/v1",
  });
  assert.deepEqual(
    result,
    createImportResult("test", artifact, context, findings, {
      format: "test/v1",
    }),
  );
  assert.equal(
    result.observations[0].schema,
    "kneekura.analyzer-observation/v1",
  );
  assert.equal(
    result.observations[0].provenance.config_digest,
    context.config_digest,
  );
  assert.equal(
    result.observations[0].raw_provider_ref.artifact_digest,
    result.artifact_digest,
  );
  assert.throws(() => {
    result.findings[0].title = "mutated";
  }, TypeError);
  assert.equal(validateImportResult(result), true);
  const tampered = structuredClone(result);
  tampered.context.snapshot_id = "other";
  assert.throws(() => validateImportResult(tampered), /digest/);
});
test("unsafe, excessive, invalid and forged imports fail closed", () => {
  for (const p of ["../x", "/etc/x", "C:\\x", "a/../b", "a\u0000b"])
    assert.throws(() => safePath(p));
  assert.throws(() => parseJsonArtifact("{bad"));
  assert.throws(
    () => parseJsonArtifact(" ".repeat(8 * 1024 * 1024 + 1)),
    /limit/,
  );
  assert.throws(() =>
    createImportResult("x", {}, { ...context, engine_id: "all" }, [], {
      format: "v1",
    }),
  );
  assert.throws(() =>
    createImportResult(
      "x",
      {},
      context,
      [
        {
          kind: "X",
          title: "x",
          sources: [{ path: "a", start_line: 9, end_line: 2 }],
        },
      ],
      { format: "v1" },
    ),
  );
  assert.throws(() => parseJsonArtifact({ x: Infinity }), /finite/);
});
