import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOfflineHumanExperienceView,
  semanticClassLabel,
  sourceKindLabel
} from '../packages/human-explorer/src/offline-human-experience.mjs';

const REPOSITORY_ID = 'repo:sha256:' + 'a'.repeat(64);
const SNAPSHOT_ID = 'snapshot:sha256:' + 'b'.repeat(64);
const IR_DIGEST = 'sha256:' + 'c'.repeat(64);
const PACK_ID = 'evidence-pack:fixture';
const PACK_DIGEST = 'sha256:' + 'd'.repeat(64);
const CONTENT_DIGEST = 'sha256:' + 'e'.repeat(64);

function payload() {
  const fileRef = {
    kind: 'FILE_RANGE',
    path: 'src/main.ts',
    start_line: 10,
    end_line: 12,
    content_digest: CONTENT_DIGEST
  };
  const rejectedRef = {
    kind: 'NODE',
    id: 'node:rejected'
  };
  return {
    schema: 'kneekura.human-experience-offline-payload/v1',
    experience: {
      schema: 'kneekura.human-experience-projection/v1',
      locale: 'ja-JP',
      repository: {
        repository_id: REPOSITORY_ID,
        snapshot_id: SNAPSHOT_ID
      },
      source_identity: {
        evidence_pack_id: PACK_ID,
        evidence_pack_digest: PACK_DIGEST,
        human_analysis_ir_digest: IR_DIGEST
      },
      derived: {
        human_analysis_ir: {
          schema: 'kneekura.human-analysis-ir/v1',
          repository: {
            repository_id: REPOSITORY_ID,
            snapshot_id: SNAPSHOT_ID
          },
          ir_digest: IR_DIGEST,
          evidence_pack: {
            pack_id: PACK_ID,
            pack_digest: PACK_DIGEST
          },
          items: [
            {
              id: 'derived:accepted',
              stage: 'ARCHITECTURE',
              kind: 'ARCHITECTURE_COMPONENT',
              semantic_class: 'AI_INTERPRETATION',
              title: '起動処理',
              body: 'ここが起動境界です。',
              source_refs: [fileRef],
              ordering_key: '01',
              review_status: 'ACCEPT',
              review_reason: 'source linked'
            },
            {
              id: 'derived:rejected',
              stage: 'ARCHITECTURE',
              kind: 'ARCHITECTURE_COMPONENT',
              semantic_class: 'AI_INTERPRETATION',
              title: '却下された説明',
              body: '通常画面へ出してはいけません。',
              source_refs: [rejectedRef],
              ordering_key: '02',
              review_status: 'REJECT',
              review_reason: 'unsupported'
            }
          ]
        }
      }
    },
    sources: {
      schema: 'kneekura.human-analysis-source-bundle/v1',
      repository: {
        repository_id: REPOSITORY_ID,
        snapshot_id: SNAPSHOT_ID
      },
      ir_digest: IR_DIGEST,
      evidence_pack: {
        pack_id: PACK_ID,
        pack_digest: PACK_DIGEST
      },
      records: [
        {
          ref: fileRef,
          instruction_authority: false,
          trust_class: 'UNTRUSTED_REPOSITORY_DATA',
          content_digest: CONTENT_DIGEST,
          text_digest: 'sha256:' + 'f'.repeat(64),
          text: 'line ten\nline eleven\nline twelve'
        },
        {
          ref: rejectedRef,
          instruction_authority: false,
          trust_class: 'CANONICAL_EVIDENCE_DATA',
          record: { id: 'node:rejected', kind: 'function' }
        }
      ]
    }
  };
}

test('offline view exposes only ACCEPT items and human file:line citations', () => {
  const view = createOfflineHumanExperienceView(payload());
  assert.equal(view.available, true);
  assert.equal(view.locale, 'ja-JP');
  assert.equal(view.items.length, 1);
  assert.equal(view.hidden_review_item_count, 1);
  assert.equal(view.items[0].title, '起動処理');
  assert.equal(view.items[0].semantic_label, 'AIによる解釈');
  assert.equal(view.items[0].sources[0].label, 'src/main.ts:10–12');
  assert.deepEqual(
    view.items[0].sources[0].rows.map(row => row.line),
    [10, 11, 12]
  );
  assert(!view.items[0].sources[0].label.includes('sha256'));
  assert.equal(view.counts.ai_interpretations, 1);
});

test('raw canonical ref stays technical while the visible label is human-readable', () => {
  const value = payload();
  value.experience.derived.human_analysis_ir.items[0].source_refs = [{
    kind: 'EVIDENCE',
    id: 'evidence:boot'
  }];
  value.sources.records = [{
    ref: { kind: 'EVIDENCE', id: 'evidence:boot' },
    instruction_authority: false,
    trust_class: 'CANONICAL_EVIDENCE_DATA',
    record: { id: 'evidence:boot', kind: 'STATIC_ANALYSIS' }
  }];
  const source = createOfflineHumanExperienceView(value).items[0].sources[0];
  assert.equal(source.label, '根拠記録');
  assert.equal(source.technical_ref.id, 'evidence:boot');
  assert(!source.label.includes('evidence:boot'));
});

test('missing bundled record is reported as unavailable without inventing a line or record', () => {
  const value = payload();
  value.sources.records = [];
  const source = createOfflineHumanExperienceView(value).items[0].sources[0];
  assert.equal(source.availability, 'UNAVAILABLE');
  assert.match(source.reason, /同梱されていません/);
  assert.deepEqual(source.rows, []);
});

test('offline view rejects repository identity drift', () => {
  const value = payload();
  value.sources.repository.repository_id =
    'repo:sha256:' + '9'.repeat(64);
  assert.throws(
    () => createOfflineHumanExperienceView(value),
    /repository identity mismatch/
  );
});

test('offline view rejects FILE_RANGE digest and line-count drift', () => {
  const digestDrift = payload();
  digestDrift.sources.records[0].content_digest =
    'sha256:' + '0'.repeat(64);
  assert.throws(
    () => createOfflineHumanExperienceView(digestDrift),
    /source digest mismatch/
  );

  const lineDrift = payload();
  lineDrift.sources.records[0].text = 'only one line';
  assert.throws(
    () => createOfflineHumanExperienceView(lineDrift),
    /source line count mismatch/
  );
});

test('Japanese presentation labels keep semantic and source machine values out of UI copy', () => {
  assert.equal(semanticClassLabel('UNKNOWN'), '未解決');
  assert.equal(semanticClassLabel('COVERAGE_GAP'), '解析範囲の不足');
  assert.equal(sourceKindLabel('CLAIM'), '主張記録');
  assert.equal(sourceKindLabel('EDGE'), '関係記録');
});