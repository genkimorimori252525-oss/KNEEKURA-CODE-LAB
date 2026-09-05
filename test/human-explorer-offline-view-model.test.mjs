import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOfflineExperienceViewModel
} from '../packages/human-explorer/src/offline-experience.mjs';

function payload() {
  const repositoryId = 'repo:sha256:' + '1'.repeat(64);
  const snapshotId = 'snapshot:sha256:' + '2'.repeat(64);
  const irDigest = 'sha256:' + '3'.repeat(64);
  const digest = 'sha256:' + '4'.repeat(64);
  const fileRef = {
    kind: 'FILE_RANGE',
    path: 'src/main.ts',
    start_line: 8,
    end_line: 10,
    content_digest: digest
  };
  const evidenceRef = { kind: 'EVIDENCE', id: 'evidence:boot' };
  return {
    schema: 'kneekura.human-experience-offline-payload/v1',
    experience: {
      schema: 'kneekura.human-experience-projection/v1',
      locale: 'ja-JP',
      projection_id: 'human-experience:fixture',
      repository: {
        repository_id: repositoryId,
        snapshot_id: snapshotId
      },
      source_identity: {
        human_analysis_ir_digest: irDigest,
        evidence_pack_id: 'evidence-pack:fixture',
        evidence_pack_digest: 'sha256:' + '5'.repeat(64),
        canonical_digest: 'sha256:' + '6'.repeat(64)
      },
      derived: {
        human_analysis_ir: {
          ir_digest: irDigest,
          items: [
            {
              id: 'item:accepted',
              stage: 'ARCHITECTURE',
              kind: 'ARCHITECTURE_COMPONENT',
              semantic_class: 'AI_INTERPRETATION',
              title: '起動処理',
              body: '<img src=x onerror=alert(1)> は文字列のまま扱う。',
              source_refs: [fileRef, evidenceRef],
              review_status: 'ACCEPT',
              review_reason: '根拠あり'
            },
            {
              id: 'item:rejected',
              stage: 'ARCHITECTURE',
              kind: 'ARCHITECTURE_COMPONENT',
              semantic_class: 'AI_INTERPRETATION',
              title: '却下説明',
              body: '通常表示してはいけない',
              source_refs: [fileRef],
              review_status: 'REJECT'
            },
            {
              id: 'item:gap',
              stage: 'COVERAGE',
              kind: 'COVERAGE_NOTE',
              semantic_class: 'COVERAGE_GAP',
              title: '未解析範囲',
              body: 'この範囲は未確認です。',
              source_refs: [evidenceRef],
              review_status: 'ACCEPT'
            }
          ]
        }
      }
    },
    sources: {
      schema: 'kneekura.human-analysis-source-bundle/v1',
      repository: {
        repository_id: repositoryId,
        snapshot_id: snapshotId
      },
      ir_digest: irDigest,
      records: [
        {
          ref: fileRef,
          instruction_authority: false,
          trust_class: 'UNTRUSTED_REPOSITORY_DATA',
          content_digest: digest,
          text_digest: 'sha256:' + '7'.repeat(64),
          text: 'line eight\n</script><script>alert(1)</script>\nline ten'
        },
        {
          ref: evidenceRef,
          instruction_authority: false,
          trust_class: 'CANONICAL_EVIDENCE_DATA',
          record_digest: 'sha256:' + '8'.repeat(64),
          record: {
            id: 'evidence:boot',
            kind: 'SOURCE',
            provenance: {
              path: 'src/main.ts',
              range: { start_line: 8, end_line: 10 }
            }
          }
        }
      ]
    }
  };
}

test('offline view model shows only ACCEPT explanations and keeps uncertainty separate', () => {
  const model = createOfflineExperienceViewModel(payload());
  assert.equal(model.available, true);
  assert.equal(model.locale, 'ja-JP');
  assert.deepEqual(model.explanations.map(item => item.id), ['item:accepted']);
  assert.deepEqual(model.uncertainties.map(item => item.id), ['item:gap']);
  assert.equal(model.rejected_count, 1);
  assert.equal(model.explanations[0].body, '<img src=x onerror=alert(1)> は文字列のまま扱う。');
});

test('FILE_RANGE citation preserves real 1-based line numbers and inert source text', () => {
  const model = createOfflineExperienceViewModel(payload());
  const source = model.explanations[0].sources[0];
  assert.equal(source.citation, 'src/main.ts:8–10');
  assert.equal(source.availability, 'INLINE_SOURCE');
  assert.deepEqual(
    source.lines.map(line => line.line_number),
    [8, 9, 10]
  );
  assert.equal(source.lines[1].text, '</script><script>alert(1)</script>');
});

test('canonical evidence gets path/range presentation without inventing source text', () => {
  const model = createOfflineExperienceViewModel(payload());
  const source = model.explanations[0].sources[1];
  assert.equal(source.reference_type, 'PATH_RANGE_RECORD');
  assert.equal(source.citation, 'src/main.ts:8–10');
  assert.equal(source.availability, 'CANONICAL_RECORD');
  assert.deepEqual(source.lines, []);
});

test('canonical evidence without a path keeps raw identity out of the normal citation', () => {
  const value = payload();
  const record = value.sources.records.find(item => item.ref.kind === 'EVIDENCE');
  delete record.record.provenance.path;
  delete record.record.provenance.range;
  const model = createOfflineExperienceViewModel(value);
  const source = model.explanations[0].sources[1];
  assert.equal(source.citation, 'canonical根拠record');
  assert.equal(source.citation.includes('evidence:boot'), false);
  assert.equal(source.technical.ref.id, 'evidence:boot');
});

test('missing source records remain explicit unavailable instead of becoming ABSENT', () => {
  const value = payload();
  value.sources.records = [];
  const model = createOfflineExperienceViewModel(value);
  assert.equal(model.explanations[0].sources[0].availability, 'UNAVAILABLE');
  assert.match(
    model.explanations[0].sources[0].unavailable_reason,
    /同梱されていません/
  );
  assert.equal(model.explanations[0].sources[1].citation, '根拠参照（未同梱）');
  assert.equal(model.explanations[0].sources[1].citation.includes('evidence:boot'), false);
});

test('offline payload identity mismatch fails closed', () => {
  const value = payload();
  value.sources.repository.snapshot_id = 'snapshot:sha256:' + 'f'.repeat(64);
  assert.throws(
    () => createOfflineExperienceViewModel(value),
    /repository\/snapshotが一致しません/
  );
});