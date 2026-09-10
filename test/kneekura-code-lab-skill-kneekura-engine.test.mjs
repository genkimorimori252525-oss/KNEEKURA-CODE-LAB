import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker
} from '../src/human-analysis/index.mjs';
import {
  HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER,
  HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA,
  HUMAN_EXPLORER_TITLE_PLACEHOLDER
} from '../src/human-experience/standalone-explorer.mjs';
import {
  runNativeKneekuraHumanGuide,
  validateEngineRunReceipt
} from '../src/skill/index.mjs';

function digest(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

function fixture() {
  const source = ['export function boot() {', '  return 1;', '}', ''].join('\n');
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
  return { pack, broker, explorerProjection };
}

function semanticAuthorHost() {
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
        source_refs: [{
          kind: 'FILE_RANGE',
          path: range.path,
          start_line: range.start_line,
          end_line: range.end_line,
          content_digest: range.content_digest
        }]
      }] };
    }
    if (envelope.stage === 'REVIEWER') {
      return {
        decisions: envelope.candidate_items.map(item => ({
          item_id: item.id,
          status: 'ACCEPT',
          reason: 'source-linked production host output'
        }))
      };
    }
    return { items: [] };
  };
}

function minimalShell() {
  const html = [
    '<!doctype html>',
    '<html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; worker-src blob:">',
    `<title>${HUMAN_EXPLORER_TITLE_PLACEHOLDER}</title>`,
    '</head><body><div id="root"></div>',
    `<script id="kneekura-human-experience" type="application/octet-stream">${HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER}</script>`,
    '<script>document.getElementById("root").textContent="KNEEKURA";</script>',
    '</body></html>'
  ].join('\n');
  return {
    schema: HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA,
    renderer: 'HUMAN_EXPLORER_V2',
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src blob:",
    html,
    digest: digest(html),
    javascript_digest: digest('fixture-js'),
    css_digest: digest('fixture-css')
  };
}

test('native KNEEKURA Skill bridge requires an explicit production semantic-author host', async () => {
  const { pack, broker, explorerProjection } = fixture();
  await assert.rejects(
    () => runNativeKneekuraHumanGuide({
      evidencePack: pack,
      sourceBroker: broker,
      explorerProjection,
      attemptId: 'attempt-no-author',
      explorerShell: minimalShell()
    }),
    error => error?.code === 'PRODUCTION_AUTHOR_HOST_REQUIRED'
  );
});

test('native KNEEKURA Skill bridge runs the existing PRODUCTION Human Explorer path and returns its offline ZIP', async () => {
  const { pack, broker, explorerProjection } = fixture();
  const result = await runNativeKneekuraHumanGuide({
    evidencePack: pack,
    sourceBroker: broker,
    explorerProjection,
    semanticAuthorHost: semanticAuthorHost(),
    semanticAuthorId: 'chatgpt-production-host',
    semanticProviderId: 'chatgpt',
    locale: 'ja-JP',
    request: { question: '人間向けに説明して', audience: 'HUMAN' },
    attemptId: 'attempt-kneekura-001',
    explorerShell: minimalShell(),
    title: 'KNEEKURA Skill fixture'
  });

  assert.equal(result.schema, 'kneekura.code-lab.kneekura-engine-result/v1');
  assert.equal(result.ir.generation.mode, 'PRODUCTION');
  assert.equal(result.ir.generation.user_deliverable, true);
  assert.equal(result.ir.generation.fallback_to_acceptance_forbidden, true);
  assert.equal(result.ir.generation.semantic_author.acceptance_fixture, false);
  assert.equal(result.ir.generation.semantic_author.id, 'chatgpt-production-host');
  assert.equal(result.readReceipts.length, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.artifact.manifest.renderer_surface, 'HUMAN_EXPLORER_V2');
  assert(Buffer.isBuffer(result.artifact.zip_bytes));
  assert(result.artifact.zip_bytes.length > 0);
  assert(result.artifact.zip_digest.startsWith('sha256:'));
  assert(result.artifact.files.some(file => file.path === 'index.html'));
  assert(result.artifact.files.some(file => file.path === 'analysis.json'));
  assert.equal(result.receipt.engineId, 'kneekura');
  assert.equal(result.receipt.implementationOrigin, 'first-party');
  assert.equal(result.receipt.orchestrationMode, 'native');
  assert.equal(result.receipt.claimLevel, 'NATIVE');
  assert.equal(result.receipt.status, 'SUCCESS');
  assert.equal(result.receipt.acceptance.production_ir, true);
  assert.equal(result.receipt.acceptance.acceptance_fallback_forbidden, true);
  assert.equal(result.receipt.acceptance.semantic_author_acceptance_fixture, false);
  assert.equal(result.receipt.artifacts[0].digest, result.artifact.zip_digest);
  assert.equal(validateEngineRunReceipt(result.receipt), true);
});