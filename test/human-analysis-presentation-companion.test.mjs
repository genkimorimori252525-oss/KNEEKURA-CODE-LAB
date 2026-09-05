import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisPresentationCompanion,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  createReadTrackedProductionSemanticAuthor,
  runProductionHumanAnalysisSemanticPipeline,
  validateHumanAnalysisPresentationCompanion
} from '../src/human-analysis/index.mjs';

const digest = text =>
  'sha256:' + crypto.createHash('sha256').update(text).digest('hex');

async function fixture() {
  const source = [
    'export function overview() {',
    '  return publish();',
    '}',
    'export function publish() { return createPullRequest(); }',
    'export function createPullRequest() { return true; }',
    ''
  ].join('\n');
  const repositoryId = 'repo:sha256:' + '1'.repeat(64);
  const snapshotId = 'snapshot:sha256:' + '2'.repeat(64);
  const repository = {
    repository_id: repositoryId,
    snapshot_id: snapshotId
  };
  const evidence = {
    id: 'evidence:overview',
    kind: 'STATIC_ANALYSIS',
    provenance: { path: 'src/main.ts' }
  };
  const pack = createHumanAnalysisEvidencePack({
    repository: { repository_id: repositoryId },
    snapshot: { snapshot_id: snapshotId },
    graph: { nodes: [], edges: [] },
    result: {
      claims: [],
      unknowns: [],
      coverage: { completeness: 'BOUNDED', entries: [] }
    },
    evidence: [evidence],
    source_catalog: [{
      path: 'src/main.ts',
      content_digest: digest(source),
      line_count: 6
    }]
  });
  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: async relative => {
      assert.equal(relative, 'src/main.ts');
      return source;
    }
  });

  const baseAuthor = createProductionSemanticAuthor({
    id: 'test-production-author',
    locale: 'ja-JP',
    provider_id: 'test-ai-provider',
    run: async (envelope, sourceBroker) => {
      if (envelope.stage === 'ARCHITECTURE') {
        const range = await sourceBroker.readFileRange({
          kind: 'FILE_RANGE',
          path: 'src/main.ts',
          start_line: 1,
          end_line: 3
        });
        const ref = {
          kind: 'FILE_RANGE',
          path: range.path,
          start_line: range.start_line,
          end_line: range.end_line,
          content_digest: range.content_digest
        };
        return { items: [
          {
            kind: 'ARCHITECTURE_COMPONENT',
            semantic_class: 'AI_INTERPRETATION',
            title: '全体像',
            body: 'overview が公開処理へ進む入口です。',
            source_refs: [ref]
          },
          {
            kind: 'ARCHITECTURE_COMPONENT',
            semantic_class: 'AI_INTERPRETATION',
            title: '公開境界',
            body: '公開処理を一つの責務として扱います。',
            source_refs: [ref]
          }
        ] };
      }
      if (envelope.stage === 'DOMAIN') return { items: [] };
      if (envelope.stage === 'FLOW') {
        const range = await sourceBroker.readFileRange({
          kind: 'FILE_RANGE',
          path: 'src/main.ts',
          start_line: 4,
          end_line: 5
        });
        return { items: [{
          kind: 'FLOW',
          semantic_class: 'AI_INTERPRETATION',
          title: '公開からPR作成まで',
          body: 'publish から createPullRequest へ進みます。',
          source_refs: [{
            kind: 'FILE_RANGE',
            path: range.path,
            start_line: range.start_line,
            end_line: range.end_line,
            content_digest: range.content_digest
          }]
        }] };
      }
      if (envelope.stage === 'TOUR') {
        const range = await sourceBroker.readFileRange({
          kind: 'FILE_RANGE',
          path: 'src/main.ts',
          start_line: 5,
          end_line: 5
        });
        return { items: [{
          kind: 'TOUR_STEP',
          semantic_class: 'AI_INTERPRETATION',
          title: 'PR作成境界を見る',
          body: '最後に createPullRequest の境界を確認します。',
          source_refs: [{
            kind: 'FILE_RANGE',
            path: range.path,
            start_line: range.start_line,
            end_line: range.end_line,
            content_digest: range.content_digest
          }],
          ordering_key: '001'
        }] };
      }
      if (envelope.stage === 'REVIEWER') {
        return {
          decisions: envelope.candidate_items.map(item => ({
            item_id: item.id,
            status: 'ACCEPT',
            reason: 'direct source read and bounded interpretation'
          }))
        };
      }
      throw new Error('unexpected stage');
    }
  });
  const tracked = createReadTrackedProductionSemanticAuthor(baseAuthor);
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: tracked.semanticAuthor,
    request: { question: '公開フローを説明して', audience: 'HUMAN' }
  });
  const receipts = tracked.getReadReceipts();
  const sources = await materialize(ir, broker);
  return { source, repository, pack, broker, ir, receipts, sources };
}

async function materialize(ir, broker) {
  const rows = new Map();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      const key = ref.kind === 'FILE_RANGE'
        ? [ref.kind, ref.path, ref.start_line, ref.end_line, ref.content_digest].join(':')
        : `${ref.kind}:${ref.id}`;
      if (rows.has(key)) continue;
      if (ref.kind === 'FILE_RANGE') {
        const value = await broker.readFileRange(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          content_digest: value.content_digest,
          text: value.text
        });
      } else {
        const value = broker.resolveCanonicalRef(ref);
        rows.set(key, {
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: value.trust_class,
          record: value.record
        });
      }
    }
  }
  return [...rows.values()];
}

function presentationInput(fx) {
  const architecture = fx.ir.items.filter(
    item => item.stage === 'ARCHITECTURE'
  );
  const flow = fx.ir.items.find(item => item.stage === 'FLOW');
  const tour = fx.ir.items.find(item => item.stage === 'TOUR');
  const flowRef = flow.source_refs[0];
  return {
    ir: fx.ir,
    evidencePack: fx.pack,
    sources: fx.sources,
    readReceipts: fx.receipts,
    scope: {
      kind: 'BOUNDED_PREVIEW',
      label: '公開フローの代表経路',
      declared_paths: ['src/main.ts']
    },
    overview_item_id: architecture[0].id,
    components: [{
      item_id: architecture[1].id,
      name: '公開境界',
      responsibility: 'workspaceの変更を外部公開へつなぐ',
      member_refs: architecture[1].source_refs
    }],
    flows: [{
      item_id: flow.id,
      name: 'publish → PR',
      entry_step_id: 'publish',
      steps: [
        { step_id: 'publish', label: '変更を公開', source_refs: [flowRef] },
        { step_id: 'pr', label: 'PRを作成', source_refs: [flowRef] }
      ],
      transitions: [{
        from_step_id: 'publish',
        to_step_id: 'pr',
        kind: 'CALL',
        source_refs: [flowRef]
      }]
    }],
    tour: [{
      item_id: tour.id,
      order: 1,
      target_refs: tour.source_refs
    }]
  };
}

test('tracked PRODUCTION author records only direct author broker reads as deterministic receipts', async () => {
  const fx = await fixture();
  assert.equal(fx.receipts.length, 3);
  assert.deepEqual(
    fx.receipts.map(item => item.stage),
    ['ARCHITECTURE', 'FLOW', 'TOUR']
  );
  assert(fx.receipts.every(item => item.read_kind === 'FILE_RANGE'));
  assert(fx.receipts.every(item => item.repository.repository_id === fx.ir.repository.repository_id));
  assert(fx.receipts.every(item => item.repository.snapshot_id === fx.ir.repository.snapshot_id));
});

test('typed companion is READY_BOUNDED_PREVIEW with accepted source-backed structures and never claims canonical authority', async () => {
  const fx = await fixture();
  const input = presentationInput(fx);
  const presentation = createHumanAnalysisPresentationCompanion(input);
  assert.equal(presentation.schema, 'kneekura.human-analysis-presentation/v1');
  assert.equal(presentation.scope.kind, 'BOUNDED_PREVIEW');
  assert.equal(presentation.scope.repository_scale_claim, false);
  assert.equal(presentation.authority.canonical_authority, false);
  assert.equal(presentation.authority.derived_presentation_only, true);
  assert.equal(presentation.components.length, 1);
  assert.equal(presentation.flows.length, 1);
  assert.equal(presentation.flows[0].transitions[0].kind, 'CALL');
  assert.equal(presentation.tour.length, 1);
  assert.equal(presentation.readiness.status, 'READY_BOUNDED_PREVIEW');
  assert.equal(presentation.readiness.repository_scale_ready, false);
  assert.equal(presentation.readiness.gaps.length, 0);
  assert.equal(
    validateHumanAnalysisPresentationCompanion(presentation, {
      ir: fx.ir,
      evidencePack: fx.pack,
      sources: fx.sources
    }),
    true
  );
});

test('typed companion becomes NOT_READY when AI read receipts are missing rather than treating later source validation as author reading', async () => {
  const fx = await fixture();
  const input = presentationInput(fx);
  input.readReceipts = [];
  const presentation = createHumanAnalysisPresentationCompanion(input);
  assert.equal(presentation.readiness.status, 'NOT_READY');
  assert.equal(presentation.readiness.direct_file_read_receipt_count, 0);
  assert(presentation.readiness.gaps.includes('NO_DIRECT_AI_SOURCE_READ'));
  assert(presentation.readiness.gaps.some(item => item.includes('PRESENTATION_ITEM_NOT_AI_READ')));
});

test('typed companion rejects flow arrows that are not supported by the accepted FLOW item source refs', async () => {
  const fx = await fixture();
  const input = presentationInput(fx);
  input.flows[0].transitions[0].source_refs = [{
    kind: 'EVIDENCE',
    id: 'evidence:overview'
  }];
  assert.throws(
    () => createHumanAnalysisPresentationCompanion(input),
    /source ref is not present on its Human Analysis item/
  );
});

test('typed companion rejects foreign flow steps and presentation identity tampering', async () => {
  const fx = await fixture();
  const badFlow = presentationInput(fx);
  badFlow.flows[0].transitions[0].to_step_id = 'invented';
  assert.throws(
    () => createHumanAnalysisPresentationCompanion(badFlow),
    /foreign step/
  );

  const presentation = createHumanAnalysisPresentationCompanion(
    presentationInput(fx)
  );
  const tampered = structuredClone(presentation);
  tampered.scope.label = '改ざん';
  assert.throws(
    () => validateHumanAnalysisPresentationCompanion(tampered, {
      ir: fx.ir,
      evidencePack: fx.pack,
      sources: fx.sources
    }),
    /presentation digest mismatch/
  );
});