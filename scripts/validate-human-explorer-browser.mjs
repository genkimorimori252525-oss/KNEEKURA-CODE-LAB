import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

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

const source = [
  'export function boot() {',
  '  return service();',
  '}',
  'export function service() { return 1; }',
  ''
].join('\n');
const repositoryId = 'repo:sha256:' + '1'.repeat(64);
const snapshotId = 'snapshot:sha256:' + '2'.repeat(64);

const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'kneekura-human-explorer-browser-')
);
let browser;
try {
  const artifact = await buildArtifact();
  const indexPath = path.join(tempRoot, 'index.html');
  await fs.writeFile(indexPath, artifact.index_html, 'utf8');

  const edgeExecutable = findEdgeExecutable();
  assert(edgeExecutable, 'Microsoft Edge executable was not found on the Windows browser acceptance runner');

  browser = await chromium.launch({
    executablePath: edgeExecutable,
    headless: true
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];

  page.on('request', request => {
    const url = request.url();
    if (/^https?:/i.test(url)) externalRequests.push(url);
  });
  page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(pathToFileURL(indexPath).href, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'このリポジトリの説明' }).waitFor();

  assert.equal(await page.getByText('起動処理', { exact: true }).count() > 0, true);
  assert.equal(await page.getByText('boot から service へ処理が進みます。', { exact: true }).count(), 1);

  const normalText = await page.locator('body').innerText();
  assert(!normalText.includes(repositoryId), 'repository_id leaked into normal UI');
  assert(!normalText.includes('Selection'), 'English Selection label remained in normal UI');
  assert(!normalText.includes('Change impact'), 'English Change impact label remained in normal UI');
  assert(!normalText.includes('Guided tour'), 'English Guided tour label remained in normal UI');

  const citation = page.getByRole('button', { name: 'src/main.ts:1–3' });
  await citation.click();
  await page.getByRole('region', { name: 'src/main.ts:1–3 のソースコード' }).waitFor();

  const lineNumbers = await page.locator('.human-guide-line-number').allTextContents();
  assert.deepEqual(lineNumbers.map(value => value.trim()), ['1', '2', '3']);
  const codeLines = await page.locator('.human-guide-code-line code').allTextContents();
  assert.deepEqual(codeLines, [
    'export function boot() {',
    '  return service();',
    '}'
  ]);

  await page.getByText('成果物の技術詳細', { exact: true }).click();
  await page.getByText(repositoryId, { exact: true }).waitFor();

  assert.deepEqual(externalRequests, [], `unexpected external requests: ${externalRequests.join(', ')}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);

  console.log(JSON.stringify({
    ok: true,
    browser: edgeExecutable,
    url: pathToFileURL(indexPath).href,
    citation: 'src/main.ts:1–3',
    external_requests: externalRequests.length,
    zip_digest: artifact.zip_digest
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function buildArtifact() {
  const repository = {
    schema: 'core.repository-identity/v1',
    vcs: 'filesystem',
    canonical_identity: 'filesystem:root:/browser-acceptance',
    repository_id: repositoryId
  };
  const snapshot = {
    schema: 'core.snapshot-identity/v1',
    kind: 'WORKSPACE',
    repository_id: repositoryId,
    content_manifest_digest: 'sha256:' + '3'.repeat(64),
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
      { id: 'node:boot', kind: 'function', path: 'src/main.ts', label: 'boot' },
      { id: 'node:service', kind: 'function', path: 'src/main.ts', label: 'service' }
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
    observation: { text: 'export function boot()' },
    provenance: {
      repository_id: repositoryId,
      snapshot_id: snapshotId,
      provider_id: 'browser-acceptance',
      provider_version: 'v1',
      path: 'src/main.ts',
      range: { start_line: 1, end_line: 3 },
      extraction_method: 'fixture'
    },
    integrity_digest: 'sha256:' + '4'.repeat(64),
    trust_class: 'repository',
    provider_id: 'browser-acceptance',
    provider_version: 'v1'
  };
  const result = {
    schema: 'core.analysis-result/v1',
    analysis_id: 'analysis:browser-acceptance',
    session_id: 'session:browser-acceptance',
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
    id: 'browser-acceptance-production-ja',
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
          }]
        };
      }
      if (envelope.stage === 'REVIEWER') {
        return {
          decisions: envelope.candidate_items.map(item => ({
            item_id: item.id,
            status: 'ACCEPT',
            reason: 'browser acceptance source-linked item'
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
  return compileProductionHumanExperienceArtifact({
    experience,
    sourceBroker: broker,
    title: 'KNEEKURA Human Explorer Browser Acceptance'
  });
}

function findEdgeExecutable() {
  const candidates = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA
  ]
    .filter(Boolean)
    .map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return candidates.find(candidate => fsSync.existsSync(candidate)) ?? null;
}

function digest(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}
