import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  planRepositoryDomainBatches,
  runRepositoryScaleProductionAuthoring,
  assertProductionHumanAnalysisIr
} from '../src/human-analysis/index.mjs';

const TEXT = {
  'packages/a/src/service.ts': 'export function service() { return 1; }\n',
  'packages/a/src/service.test.ts': 'test("service", () => {});\n',
  'packages/b/src/worker.ts': 'export function worker() { return 2; }\n',
  'packages/b/src/worker.test.ts': 'test("worker", () => {});\n'
};

function digest(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

function setup() {
  const sourceCatalog = Object.entries(TEXT).map(([path, text]) => ({
    path,
    content_digest: digest(text),
    line_count: text.split(/\r?\n/).length
  }));
  const pack = createHumanAnalysisEvidencePack({
    repository: { repository_id: 'repo:test' },
    snapshot: { snapshot_id: 'snapshot:test' },
    source_catalog: sourceCatalog
  });
  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: async path => TEXT[path]
  });
  const plan = planRepositoryDomainBatches(sourceCatalog);
  const records = plan.batches.map(batch => ({
    batch_id: batch.batch_id,
    representative_path: batch.representative_path,
    title: `${batch.domain} の代表責務`,
    body: `${batch.representative_path} を直接確認した範囲でのAI解釈です。batch内の未読ファイルへは一般化しません。`
  }));
  return { sourceCatalog, pack, broker, plan, records };
}

test('R4 repository-scale production author reads one representative source per batch and reviews every item', async () => {
  const { pack, broker, plan, records } = setup();
  const run = await runRepositoryScaleProductionAuthoring({
    evidencePack: pack,
    sourceBroker: broker,
    batchPlan: plan,
    records
  });
  assert.equal(assertProductionHumanAnalysisIr(run.ir), true);
  assert.equal(run.ir.generation.semantic_author.acceptance_fixture, false);
  assert.equal(run.ir.items.filter(item => item.stage === 'DOMAIN').length, plan.batches.length);
  assert.equal(run.ir.review.rejected_item_ids.length, 0);
  assert.equal(run.read_receipts.filter(row => row.read_kind === 'FILE_RANGE').length, plan.batches.length);
  assert.equal(run.sources.length, plan.batches.length);
  assert.deepEqual(
    run.integration_review.reviewed_batch_ids,
    plan.batches.map(row => row.batch_id).sort()
  );
});

test('R4 repository-scale production author fails if saved authoring records do not cover every deterministic batch', async () => {
  const { pack, broker, plan, records } = setup();
  await assert.rejects(
    runRepositoryScaleProductionAuthoring({
      evidencePack: pack,
      sourceBroker: broker,
      batchPlan: plan,
      records: records.slice(1)
    }),
    /cover every batch/
  );
});