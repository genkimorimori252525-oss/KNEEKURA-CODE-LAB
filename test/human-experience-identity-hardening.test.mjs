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
  const evidence = {
    id: 'evidence:boot',
    kind: 'STATIC_ANALYSIS',
    provenance: {
      path: 'src/main.ts',
      range: { start_line: 1, end_line: 3 }
    }
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
    evidence: [evidence],
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
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: createProductionSemanticAuthor({
      id: 'identity-hardening-fixture',
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
              body: 'boot がこの例の入口です。',
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
              reason: 'source-linked'
            }))
          };
        }
        return { items: [] };
      }
    })
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
  return {
    pack,
    ir,
    explorerProjection,
    experience: createHumanExperienceProjection({
      explorerProjection,
      evidencePack: pack,
      humanAnalysisIr: ir
    })
  };
}

function recomputeProjectionId(projection) {
  const clone = structuredClone(projection);
  delete clone.projection_id;
  projection.projection_id =
    'human-experience:' + stableDigest(clone).slice('sha256:'.length);
  return projection;
}

test('constructor rejects missing Explorer snapshot identity instead of filtering it away', async () => {
  const { pack, ir, explorerProjection } = await fixture();
  const missing = structuredClone(explorerProjection);
  delete missing.source.snapshot_id;
  assert.throws(
    () => createHumanExperienceProjection({
      explorerProjection: missing,
      evidencePack: pack,
      humanAnalysisIr: ir
    }),
    /Explorer snapshot identity is required/
  );
});

test('validator rejects outer repository drift even when projection_id is recomputed', async () => {
  const { experience } = await fixture();
  const tampered = structuredClone(experience);
  tampered.repository.repository_id =
    'repo:sha256:' + 'f'.repeat(64);
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /repository identity mismatch/
  );
});

test('validator rejects outer snapshot drift even when projection_id is recomputed', async () => {
  const { experience } = await fixture();
  const tampered = structuredClone(experience);
  tampered.repository.snapshot_id =
    'snapshot:sha256:' + 'e'.repeat(64);
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /snapshot identity mismatch/
  );
});

test('validator rechecks duplicated source identity and derived source links', async () => {
  const { experience } = await fixture();
  const sourceTampered = structuredClone(experience);
  sourceTampered.source_identity.evidence_pack_id = 'evidence-pack:foreign';
  recomputeProjectionId(sourceTampered);
  assert.throws(
    () => validateHumanExperienceProjection(sourceTampered),
    /source identity does not match Human Analysis IR/
  );

  const linkTampered = structuredClone(experience);
  linkTampered.derived.item_source_links[0].source_refs = [];
  recomputeProjectionId(linkTampered);
  assert.throws(
    () => validateHumanExperienceProjection(linkTampered),
    /derived item source links do not match Human Analysis IR/
  );
});

test('validator rechecks source-index ranges instead of trusting a recomputed projection digest', async () => {
  const { experience } = await fixture();
  const tampered = structuredClone(experience);
  tampered.source_index.ranges = [];
  recomputeProjectionId(tampered);
  assert.throws(
    () => validateHumanExperienceProjection(tampered),
    /source index ranges do not match Human Analysis IR/
  );
});