import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAcceptanceSemanticAuthor,
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  runAcceptanceHumanAnalysisSemanticPipeline,
  runProductionHumanAnalysisSemanticPipeline,
  assertProductionHumanAnalysisIr
} from '../src/human-analysis/index.mjs';
import {
  createHumanExperienceProjection,
  validateHumanExperienceProjection
} from '../src/human-experience/index.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function digest(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

function fixture() {
  const source = [
    'export function boot() {',
    '  return 1;',
    '}',
    ''
  ].join('\n');
  const repositoryId = 'repo:sha256:' + 'a'.repeat(64);
  const snapshotId = 'snapshot:sha256:' + 'b'.repeat(64);
  const graphNode = { id: 'node:boot', kind: 'function', path: 'src/main.ts' };
  const evidence = {
    id: 'evidence:boot',
    kind: 'STATIC_ANALYSIS',
    provenance: { path: 'src/main.ts', range: { start_line: 1, end_line: 3 } }
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
  return { source, pack, broker, explorerProjection };
}

function semanticRun() {
  return async (envelope, broker) => {
    if (envelope.stage === 'ARCHITECTURE') {
      const range = await broker.readFileRange({
        kind: 'FILE_RANGE',
        path: 'src/main.ts',
        start_line: 1,
        end_line: 3
      });
      return { items: [{
        kind: 'ARCHITECTURE_COMPONENT',
        semantic_class: 'AI_INTERPRETATION',
        title: '起動境界',
        body: 'boot がこの小さな例の入口です。',
        source_refs: [
          { kind: 'EVIDENCE', id: 'evidence:boot' },
          {
            kind: 'FILE_RANGE',
            path: 'src/main.ts',
            start_line: 1,
            end_line: 3,
            content_digest: range.content_digest
          }
        ]
      }] };
    }
    if (envelope.stage === 'REVIEWER') {
      return {
        decisions: envelope.candidate_items.map(item => ({
          item_id: item.id,
          status: 'ACCEPT',
          reason: 'source-linked and authority class preserved'
        }))
      };
    }
    return { items: [] };
  };
}

test('package exports production Human Analysis and Human Experience contracts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./human-analysis'], './src/human-analysis/index.mjs');
  assert.equal(pkg.exports['./human-experience'], './src/human-experience/index.mjs');
  const delivery = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/human-analysis-delivery.v1.json'), 'utf8'));
  assert.equal(delivery.generation.default_mode, 'PRODUCTION');
  assert.equal(delivery.generation.production.default_locale, 'ja-JP');
  assert.equal(delivery.generation.production.acceptance_fallback_forbidden, true);
  assert.equal(delivery.generation.acceptance.user_deliverable, false);
});

test('production pipeline fails closed without a production semantic author', async () => {
  const { pack, broker } = fixture();
  await assert.rejects(
    () => runProductionHumanAnalysisSemanticPipeline({ evidencePack: pack, sourceBroker: broker }),
    error => error?.code === 'PRODUCTION_AUTHOR_REQUIRED'
  );
  const acceptance = createAcceptanceSemanticAuthor({
    id: 'fixture-acceptance',
    run: semanticRun()
  });
  await assert.rejects(
    () => runProductionHumanAnalysisSemanticPipeline({ evidencePack: pack, sourceBroker: broker, semanticAuthor: acceptance }),
    error => error?.code === 'PRODUCTION_AUTHOR_MODE_REQUIRED'
  );
});

test('acceptance output is explicitly non-deliverable and cannot pass production IR gate', async () => {
  const { pack, broker } = fixture();
  const author = createAcceptanceSemanticAuthor({
    id: 'fixture-acceptance',
    run: semanticRun()
  });
  const ir = await runAcceptanceHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: author,
    request: { question: 'acceptance only' }
  });
  assert.equal(ir.generation.mode, 'ACCEPTANCE');
  assert.equal(ir.generation.user_deliverable, false);
  assert.equal(ir.generation.semantic_author.acceptance_fixture, true);
  assert.throws(
    () => assertProductionHumanAnalysisIr(ir),
    error => error?.code === 'PRODUCTION_IR_REQUIRED'
  );
});

test('production author produces explicitly deliverable source-linked IR', async () => {
  const { pack, broker } = fixture();
  const author = createProductionSemanticAuthor({
    id: 'fixture-production-ja',
    locale: 'ja-JP',
    run: semanticRun()
  });
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: author,
    request: { question: '人間向けに説明して', audience: 'HUMAN' }
  });
  assert.equal(ir.generation.mode, 'PRODUCTION');
  assert.equal(ir.generation.user_deliverable, true);
  assert.equal(ir.generation.semantic_author.locale, 'ja-JP');
  assert.equal(ir.generation.semantic_author.acceptance_fixture, false);
  assert.equal(assertProductionHumanAnalysisIr(ir), true);
  assert(ir.items.every(item => item.semantic_class !== 'CANONICAL_FACT'));
  assert(ir.items.every(item => item.source_refs.length > 0));
});

test('Human Experience projection joins Explorer, Evidence, derived IR and source ranges without minting canonical facts', async () => {
  const { pack, broker, explorerProjection } = fixture();
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: createProductionSemanticAuthor({
      id: 'fixture-production-ja',
      locale: 'ja-JP',
      run: semanticRun()
    })
  });
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });
  assert.equal(experience.locale, 'ja-JP');
  assert.equal(experience.repository.repository_id, pack.repository.repository_id);
  assert.equal(experience.source_identity.evidence_pack_id, pack.pack_id);
  assert.equal(experience.source_identity.human_analysis_ir_digest, ir.ir_digest);
  assert.equal(experience.canonical.explorer_projection.canonical.graph.nodes.length, 1);
  assert.equal(experience.derived.human_analysis_ir.items.length, 1);
  assert.equal(experience.source_index.ranges.length, 1);
  assert.equal(experience.source_index.ranges[0].path, 'src/main.ts');
  assert.equal(experience.invariants.analysis_authority, false);
  assert.equal(experience.invariants.may_mint_canonical_nodes, false);
  assert.equal(experience.invariants.may_mint_canonical_edges, false);
  assert.equal(experience.invariants.ai_interpretation_remains_derived, true);
  assert.equal(validateHumanExperienceProjection(experience), true);
});

test('Human Experience projection rejects repository/snapshot/evidence-pack drift', async () => {
  const { pack, broker, explorerProjection } = fixture();
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: createProductionSemanticAuthor({
      id: 'fixture-production-ja',
      run: semanticRun()
    })
  });
  const wrongSnapshot = structuredClone(explorerProjection);
  wrongSnapshot.source.snapshot_id = 'snapshot:sha256:' + 'f'.repeat(64);
  assert.throws(
    () => createHumanExperienceProjection({ explorerProjection: wrongSnapshot, evidencePack: pack, humanAnalysisIr: ir }),
    /snapshot identity mismatch/
  );
  const foreignIr = structuredClone(ir);
  foreignIr.evidence_pack.pack_id = 'evidence-pack:foreign';
  delete foreignIr.ir_digest;
  assert.throws(
    () => createHumanExperienceProjection({ explorerProjection, evidencePack: pack, humanAnalysisIr: foreignIr }),
    /IR digest is required|does not reference the supplied Evidence Pack/
  );
});

test('Human Experience projection digest detects presentation-layer tampering', async () => {
  const { pack, broker, explorerProjection } = fixture();
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: createProductionSemanticAuthor({
      id: 'fixture-production-ja',
      run: semanticRun()
    })
  });
  const experience = createHumanExperienceProjection({ explorerProjection, evidencePack: pack, humanAnalysisIr: ir });
  const tampered = structuredClone(experience);
  tampered.locale = 'en';
  assert.throws(() => validateHumanExperienceProjection(tampered), /projection digest mismatch/);
});
