import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planRepositoryDomainBatches,
  validateRepositoryDomainBatchPlan
} from '../src/human-analysis/index.mjs';

const digest = char => 'sha256:' + char.repeat(64);
const catalog = [
  { path: 'packages/github/src/client.test.ts', content_digest: digest('a'), line_count: 1 },
  { path: 'packages/github/src/client.ts', content_digest: digest('b'), line_count: 1 },
  { path: 'packages/github/src/index.ts', content_digest: digest('c'), line_count: 1 },
  { path: 'packages/workspace/src/manager.ts', content_digest: digest('d'), line_count: 1 },
  { path: 'adapters/cli/src/index.ts', content_digest: digest('e'), line_count: 1 },
  { path: 'tests/integration/control-plane.test.ts', content_digest: digest('f'), line_count: 1 }
];

test('R4 batch planner partitions repository inventory by stable domain', () => {
  const plan = planRepositoryDomainBatches(catalog);
  assert.equal(plan.inventory_file_count, catalog.length);
  assert.deepEqual(
    plan.batches.map(batch => batch.domain),
    ['adapters/cli', 'packages/github', 'packages/workspace', 'tests/integration']
  );
  const github = plan.batches.find(batch => batch.domain === 'packages/github');
  assert.equal(github.representative_path, 'packages/github/src/client.ts');
  assert.equal(new Set(plan.batches.flatMap(batch => batch.paths)).size, catalog.length);
  assert.equal(validateRepositoryDomainBatchPlan(plan, catalog), true);
});

test('R4 batch planner chunks one oversized domain without losing deterministic coverage', () => {
  const expanded = Array.from({ length: 5 }, (_, index) => ({
    path: `packages/github/src/file-${index}.ts`,
    content_digest: digest(String(index % 10)),
    line_count: 1
  }));
  const plan = planRepositoryDomainBatches(expanded, { maxFilesPerBatch: 2 });
  assert.equal(plan.batches.length, 3);
  assert.deepEqual(plan.batches.map(batch => batch.paths.length), [2, 2, 1]);
  assert.equal(plan.batches.flatMap(batch => batch.paths).length, 5);
});