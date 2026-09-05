import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  runProductionHumanAnalysisSemanticPipeline
} from '../src/human-analysis/index.mjs';
import { stableDigest } from '../src/human-analysis/schema.mjs';
import {
  createHumanExperienceProjection,
  validateHumanExperienceProjection
} from '../src/human-experience/index.mjs';

function digest(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

async function fixture() {
  const source = [
    'export function boot() {',
    '  return 1;',
    '}',
    ''
  ].join('\n');
  const repositoryId = 'repo:sha256:' + 'a'.repeat(64);
  const snapshotId = 'snapshot:sha256:' + 'b'.repeat(64);
  const graphNode = {
    id: 'node:boot',
    kind: 'function',
    path: 'src/main.ts'
  };
  const pack = createHumanAnalysisEvidencePack({
    repository: { repository_id: repositoryId },
    snapshot: { snapshot_id: snapshotId },
    graph: { nodes: [graphNode], edges: [] },
    result: {
      claims: [],
      unknowns: [],
      coverage: { completeness: 'BOUNDED', entries: [] }
    },
    evidence: [],
    source_catalog: [{
      path: 'src/main.ts',
      content_digest: digest(source),
      line_count: 4
    }]
  });
  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: async relative => {
      assert.equal(relative, 'src/main.ts');
      return source;
    }
  });
  const author = createProductionSemanticAuthor({
    id: 'identity-adversarial-production',
    locale: 'ja-JP',
    run: async (envelope, sourceBroker) => {
      if (envelope.stage === 'ARCHITECTURE') {
        const range = await sourceBroker.readFileRange({
          kind: 'FILE_RANGE',
          path: 'src/main.ts',
          start_line: 1,
          end_line: 3
        });
        return {
          items: [{
            kind: 'ARCHITECTURE_COMPONENT',
            semantic_class: 'AI_INTERPRETATION',
            title: '起動境界',
            body: 'boot が入口です。',
            source_refs: [{
              kind: 'FILE_RANGE',
              path: 'src/main.ts',
              start_line: 1,
              end_line: 3,
              content_digest: range.content_digest
            }]
          }]
        };
      }
      if (envelope.stage === 'REVIEWER') {
        return {
          decisions: envelope.candidate_items.map(item => ({
            item_id: item.id,
            status: 'ACCEPT',
            reason: 'source linked'
          }))
        };
      }
      return { items: [] };
    }
  });
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: author
  });
  const explorerProjection = {
    schema: 'kneekura.explorer-projection/v1',
    source: {
      repository_id: repositoryId,
      snapshot_id: snapshotId,
      analysis_result_digest: 'sha256:' + 'c'.repeat(64)
    },
    canonical: {
      graph: { nodes: [graphNode], edges: [] },
      result: { claims: [], coverage: { entries: [] } }
    },
    presentation: {
      nodes: [{
        node_id: 'node:boot',
        canonical_index: 0,
        canonical_kind: 'function',
        display_family: 'source',
        label: 'boot'
      }],
      edges: [],
      claims: [],
      coverage: []
    }
  };
  return { pack, ir, explorerProjection };
}

function recomputeProjectionId(projection) {
  const clone = structuredClone(projection);
  delete clone.projection_id;
  projection.projection_id =
    'human-experience:' +
    stableDigest(clone).slice('sha256:'.length);
  return projection;
}

test('constructor rejects a missing Explorer repository identity', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const missing = structuredClone(explorerProjection);
  delete missing.source.repository_id;
  assert.throws(
    () => createHumanExperienceProjection({
      explorerProjection: missing,
      evidencePack: pack,
      humanAnalysisIr: ir
    }),
    /repository identity missing/
  );
});

test('constructor rejects a missing Explorer snapshot identity', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const missing = structuredClone(explorerProjection);
  delete missing.source.snapshot_id;
  assert.throws(
    () => createHumanExperienceProjection({
      explorerProjection: missing,
      evidencePack: pack,
      humanAnalysisIr: ir
    }),
    /snapshot identity missing/
  );
});

test('validator rejects outer repository drift even after projection digest is recomputed', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });
  const tampered = structuredClone(experience);
  tampered.repository.repository_id =
    'repo:sha256:' + 'f'.repeat(64);
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /repository identity mismatch/
  );
});

test('validator rejects evidence-pack source identity drift after digest recomputation', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });
  const tampered = structuredClone(experience);
  tampered.source_identity.evidence_pack_id =
    'evidence-pack:foreign';
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /Evidence Pack ID identity mismatch/
  );
});

test('validator rejects projected source-range drift after digest recomputation', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });
  const tampered = structuredClone(experience);
  tampered.source_index.ranges[0].start_line = 2;
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /source index ranges mismatch/
  );
});