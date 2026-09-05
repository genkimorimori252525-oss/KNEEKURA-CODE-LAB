import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  compileHumanAnalysisArtifact,
  compileProductionHumanExperienceArtifact,
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  runProductionHumanAnalysisSemanticPipeline
} from '../src/human-analysis/index.mjs';
import {
  buildStandaloneHumanExplorerShell,
  createHumanExperienceProjection
} from '../src/human-experience/index.mjs';

function digest(text) {
  return 'sha256:' +
    crypto.createHash('sha256').update(text).digest('hex');
}

async function fixture() {
  const source = [
    'export function boot() {',
    '  return service();',
    '}',
    'export function service() { return 1; }',
    ''
  ].join('\n');
  const repositoryId =
    'repo:sha256:' + '1'.repeat(64);
  const snapshotId =
    'snapshot:sha256:' + '2'.repeat(64);
  const repository = {
    schema: 'core.repository-identity/v1',
    vcs: 'filesystem',
    canonical_identity:
      'filesystem:root:/offline-explorer-fixture',
    repository_id: repositoryId
  };
  const snapshot = {
    schema: 'core.snapshot-identity/v1',
    kind: 'WORKSPACE',
    repository_id: repositoryId,
    content_manifest_digest:
      'sha256:' + '3'.repeat(64),
    content_manifest: [],
    snapshot_id: snapshotId
  };
  const graph = {
    schema: 'kneekura.graph/v1',
    meta: {
      repository: { repository_id: repositoryId },
      snapshot: { snapshot_id: snapshotId }
    },
    nodes: [
      {
        id: 'node:boot',
        kind: 'function',
        path: 'src/main.ts',
        label: 'boot'
      },
      {
        id: 'node:service',
        kind: 'function',
        path: 'src/main.ts',
        label: 'service'
      }
    ],
    edges: [{
      id: 'edge:boot-service',
      type: 'CALLS',
      from: 'node:boot',
      to: 'node:service'
    }]
  };
  const evidence = {
    schema: 'core.evidence/v1',
    id: 'evidence:boot',
    kind: 'SOURCE',
    observation: {
      text: 'export function boot()'
    },
    provenance: {
      repository_id: repositoryId,
      snapshot_id: snapshotId,
      provider_id: 'offline-explorer-fixture',
      provider_version: 'v1',
      path: 'src/main.ts',
      range: { start_line: 1, end_line: 3 },
      extraction_method: 'fixture'
    },
    integrity_digest:
      'sha256:' + '4'.repeat(64),
    trust_class: 'repository',
    provider_id: 'offline-explorer-fixture',
    provider_version: 'v1'
  };
  const result = {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:offline-explorer',
    session_id: 'session:offline-explorer',
    repository,
    snapshot,
    status: 'COMPLETE',
    coverage: {
      schema: 'core.coverage/v1',
      completeness: 'COMPLETE',
      entries: []
    },
    claims: [],
    evidence: [evidence],
    unknowns: [],
    failures: []
  };
  const pack = createHumanAnalysisEvidencePack({
    repository,
    snapshot,
    graph,
    result,
    evidence: [evidence],
    source_catalog: [{
      path: 'src/main.ts',
      content_digest: digest(source),
      line_count: 5
    }]
  });
  const broker = createHumanAnalysisSourceBroker(
    pack,
    {
      readSource: async relative => {
        assert.equal(relative, 'src/main.ts');
        return source;
      }
    }
  );
  const author = createProductionSemanticAuthor({
    id: 'offline-explorer-production-ja',
    locale: 'ja-JP',
    run: async (envelope, sourceBroker) => {
      if (envelope.stage === 'ARCHITECTURE') {
        const range = await sourceBroker.readFileRange({
          kind: 'FILE_RANGE',
          path: 'src/main.ts',
          start_line: 1,
          end_line: 3
        });
        return { items: [{
          kind: 'ARCHITECTURE_COMPONENT',
          semantic_class: 'AI_INTERPRETATION',
          title: '起動処理',
          body: 'boot から service へ処理が進みます。',
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
          decisions: envelope.candidate_items.map(
            item => ({
              item_id: item.id,
              status: 'ACCEPT',
              reason: 'source-linked'
            })
          )
        };
      }
      return { items: [] };
    }
  });
  const ir =
    await runProductionHumanAnalysisSemanticPipeline({
      evidencePack: pack,
      sourceBroker: broker,
      semanticAuthor: author
    });

  const {
    createExplorerProjection
  } = await import(
    '../src/presentation/explorer/project.mjs'
  );
  const explorerProjection =
    createExplorerProjection({ graph, result });
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });

  return { ir, experience, broker };
}

test('standalone Human Explorer shell is deterministic and has no external JS/CSS dependencies', async () => {
  const one = await buildStandaloneHumanExplorerShell();
  const two = await buildStandaloneHumanExplorerShell();
  assert.equal(one.schema, 'kneekura.human-explorer-standalone-shell/v1');
  assert.equal(one.renderer, 'HUMAN_EXPLORER_V2');
  assert.equal(one.html, two.html);
  assert.equal(one.digest, two.digest);
  assert.match(one.html, /kneekura-human-experience/);
  assert.match(one.html, /Content-Security-Policy/);
  assert.doesNotMatch(one.html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(one.html, /<link\b[^>]*\bhref\s*=/i);
});

test('minimal card compiler refuses PRODUCTION IR', async () => {
  const { ir } = await fixture();
  assert.throws(
    () => compileHumanAnalysisArtifact({
      ir,
      sources: [],
      title: 'Bad production path'
    }),
    error => error?.code === 'PRODUCTION_EXPLORER_REQUIRED'
  );
});

test('production artifact rejects caller-supplied source text without a Source Broker', async () => {
  const { experience } = await fixture();
  const fileRef = experience.derived.human_analysis_ir.items[0].source_refs.find(
    ref => ref.kind === 'FILE_RANGE'
  );
  await assert.rejects(
    () => compileProductionHumanExperienceArtifact({
      experience,
      sources: [{
        ref: fileRef,
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA',
        content_digest: fileRef.content_digest,
        text: 'forged text with a borrowed whole-file digest'
      }]
    }),
    error => error?.code === 'PRODUCTION_SOURCE_BROKER_REQUIRED'
  );
});

test('production artifact boots the full bundled Human Explorer and preserves deterministic ZIP/security metadata', async () => {
  const { experience, broker } = await fixture();
  const shell = await buildStandaloneHumanExplorerShell();
  const one =
    await compileProductionHumanExperienceArtifact({
      experience,
      sourceBroker: broker,
      title: 'Love-Github Human Explorer',
      explorerShell: shell
    });
  const two =
    await compileProductionHumanExperienceArtifact({
      experience,
      sourceBroker: broker,
      title: 'Love-Github Human Explorer',
      explorerShell: shell
    });

  assert.equal(
    one.manifest.renderer_surface,
    'HUMAN_EXPLORER_V2'
  );
  assert.equal(
    one.manifest.renderer_version,
    'human-explorer-v2'
  );
  assert.equal(
    one.manifest.security.external_network_required,
    false
  );
  assert.equal(
    one.manifest.human_explorer_shell_digest,
    shell.digest
  );
  assert.equal(one.artifact_id, two.artifact_id);
  assert.equal(one.index_html, two.index_html);
  assert(one.zip_bytes.equals(two.zip_bytes));
  assert.equal(one.zip_digest, two.zip_digest);
  assert.doesNotMatch(one.index_html, /4 derived items/);
  assert.doesNotMatch(one.index_html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(one.index_html, /<link\b[^>]*\bhref\s*=/i);
  assert.match(one.index_html, /kneekura-human-experience/);

  const names = new Set(one.files.map(file => file.path));
  for (const required of [
    'analysis.json',
    'coverage.json',
    'experience.json',
    'explorer-projection.json',
    'index.html',
    'manifest.json',
    'README.md',
    'sources.json'
  ]) {
    assert(names.has(required), required);
  }

  const match = one.index_html.match(
    /<script id="kneekura-human-experience" type="application\/octet-stream">([^<]+)<\/script>/
  );
  assert(match);
  const payload = JSON.parse(
    Buffer.from(match[1], 'base64').toString('utf8')
  );
  assert.equal(
    payload.schema,
    'kneekura.human-experience-offline-payload/v1'
  );
  assert.equal(
    payload.experience.schema,
    'kneekura.human-experience-projection/v1'
  );
  assert.equal(
    payload.sources.schema,
    'kneekura.human-analysis-source-bundle/v1'
  );
  assert(
    payload.sources.records.some(
      row => typeof row.text === 'string'
    )
  );
  assert(
    payload.sources.records.every(
      row => row.instruction_authority === false
    )
  );
});
