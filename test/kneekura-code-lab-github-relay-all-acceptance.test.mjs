import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/validate-kneekura-code-lab-relay-all-isolation.mjs', import.meta.url));

test('ALL Relay fixture acceptance proves semantic isolation and deterministic sealed composition', () => {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());

  assert.equal(report.schema, 'kneekura.code-lab.github-relay-all-isolation-report/v1');
  assert.equal(report.parent_semantic_task_count, 0);
  assert.equal(report.context_ids_distinct, true);
  assert.equal(report.cross_child_response_rejected, true);
  assert.equal(report.cross_child_source_request_rejected, true);
  assert.equal(report.same_snapshot, true);
  assert.equal(report.same_scope, true);
  assert.equal(report.child_artifacts_verified, 3);
  assert.equal(report.comparison.semantic_fusion, false);
  assert.equal(report.comparison.canonical_truth_promotion, false);
  assert.equal(report.comparison.engine_substitution, false);
  assert.equal(report.deterministic_bundle, true);
  assert.deepEqual(report.critical_high_findings, []);
});