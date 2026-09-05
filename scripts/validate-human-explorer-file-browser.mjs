import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  compileProductionHumanExperienceArtifact,
  createHumanAnalysisEvidencePack,
  createHumanAnalysisSourceBroker,
  createProductionSemanticAuthor,
  runProductionHumanAnalysisSemanticPipeline
} from '../src/human-analysis/index.mjs';
import {
  createHumanExperienceProjection
} from '../src/human-experience/index.mjs';
import {
  createExplorerProjection
} from '../src/presentation/explorer/project.mjs';

function digest(text) {
  return 'sha256:' +
    crypto.createHash('sha256').update(text).digest('hex');
}

async function buildArtifact() {
  const source = [
    'export function boot() {',
    '  return service();',
    '}',
    'export function service() { return 1; }',
    ''
  ].join('\n');
  const repositoryId =
    'repo:sha256:' + '7'.repeat(64);
  const snapshotId =
    'snapshot:sha256:' + '8'.repeat(64);
  const repository = {
    schema: 'core.repository-identity/v1',
    vcs: 'filesystem',
    canonical_identity:
      'filesystem:root:/file-browser-fixture',
    repository_id: repositoryId
  };
  const snapshot = {
    schema: 'core.snapshot-identity/v1',
    kind: 'WORKSPACE',
    repository_id: repositoryId,
    content_manifest_digest:
      'sha256:' + '9'.repeat(64),
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
      provider_id: 'file-browser-fixture',
      provider_version: 'v1',
      path: 'src/main.ts',
      extraction_method: 'fixture'
    },
    integrity_digest:
      'sha256:' + 'a'.repeat(64),
    trust_class: 'repository',
    provider_id: 'file-browser-fixture',
    provider_version: 'v1'
  };
  const result = {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:file-browser',
    session_id: 'session:file-browser',
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
  const broker = createHumanAnalysisSourceBroker(pack, {
    readSource: async relative => {
      assert.equal(relative, 'src/main.ts');
      return source;
    }
  });
  const author = createProductionSemanticAuthor({
    id: 'file-browser-production-ja',
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
            title: '起動処理',
            body: 'boot から service へ処理が進みます。',
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
  });
  const ir = await runProductionHumanAnalysisSemanticPipeline({
    evidencePack: pack,
    sourceBroker: broker,
    semanticAuthor: author
  });
  const explorerProjection = createExplorerProjection({ graph, result });
  const experience = createHumanExperienceProjection({
    explorerProjection,
    evidencePack: pack,
    humanAnalysisIr: ir
  });
  const sources = [];
  for (const item of ir.items) {
    for (const ref of item.source_refs) {
      if (ref.kind === 'FILE_RANGE') {
        const row = await broker.readFileRange(ref);
        sources.push({
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: row.trust_class,
          content_digest: row.content_digest,
          text: row.text
        });
      } else {
        const row = broker.resolveCanonicalRef(ref);
        sources.push({
          ref: structuredClone(ref),
          instruction_authority: false,
          trust_class: row.trust_class,
          record: row.record
        });
      }
    }
  }
  return compileProductionHumanExperienceArtifact({
    experience,
    sources,
    title: 'KNEEKURA file browser acceptance'
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && path.join(
      process.env.LOCALAPPDATA,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    process.env.PROGRAMFILES && path.join(
      process.env.PROGRAMFILES,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    process.env['PROGRAMFILES(X86)'] && path.join(
      process.env['PROGRAMFILES(X86)'],
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    )
  ].filter(Boolean);
  const found = candidates.find(candidate => fsSync.existsSync(candidate));
  if (!found) {
    throw new Error(
      'Chrome executable was not found on the Windows self-hosted runner. ' +
      'Set CHROME_PATH or install Chrome before accepting file:// browser coverage.'
    );
  }
  return found;
}

const artifact = await buildArtifact();
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'kneekura-human-explorer-browser-')
);
const profile = path.join(root, 'chrome-profile');
const indexPath = path.join(root, 'index.html');
await fs.writeFile(indexPath, artifact.index_html, 'utf8');

try {
  const chrome = findChrome();
  const launched = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--virtual-time-budget=5000',
      `--user-data-dir=${profile}`,
      '--dump-dom',
      pathToFileURL(indexPath).href
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (launched.error) throw launched.error;
  if (launched.status !== 0) {
    throw new Error(
      'Chrome file:// acceptance failed with exit ' +
      launched.status + '\n' +
      String(launched.stderr ?? '').slice(-4000)
    );
  }
  const dom = String(launched.stdout ?? '');
  for (const required of [
    'KNEEKURA コードエクスプローラー',
    'AIによるコード案内',
    '起動処理',
    'src/main.ts:1–3',
    'export function boot()'
  ]) {
    assert(
      dom.includes(required),
      `file:// rendered DOM is missing: ${required}`
    );
  }
  assert(!dom.includes('Explorer presentation failed.'));
  console.log(
    'Human Explorer file:// Chrome acceptance: PASS ' +
    artifact.artifact_id
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}