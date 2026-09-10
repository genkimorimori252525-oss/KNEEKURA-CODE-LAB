import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { createHostTask } from '../mcp/src/host-bridge-contract.mjs';
import { projectHostSemanticInput } from '../mcp/src/host-task-payload.mjs';

const CANONICAL = 'git:github.com/genkimorimori252525-oss/kneekura-lab';
const BINDING = Object.freeze({
  runId: 'ghr-ua-stable-identity',
  engineId: 'understand-anything',
  attemptId: 'attempt-ua-stable-1-understand-anything',
  snapshotId: `snapshot:sha256:${'a'.repeat(64)}`,
  scopeDigest: `sha256:${'b'.repeat(64)}`
});

function task(kind, ordinal, projectRoot, extra = {}) {
  const semanticInput = projectHostSemanticInput({
    kind,
    payload: {
      schema: 'kneekura.code-lab.ua-role-input/v1',
      projectRoot,
      ...extra
    },
    canonicalRepositoryIdentity: CANONICAL
  });
  return createHostTask({
    ...BINDING,
    ordinal,
    kind,
    payload: {
      schema: 'kneekura.code-lab.host-task-public-payload/v1',
      kind,
      target: {
        repository: CANONICAL,
        revision: 'c'.repeat(40),
        snapshot_id: BINDING.snapshotId,
        scope_digest: BINDING.scopeDigest
      },
      source_catalog: {
        entry_count: 2,
        browse_via_host_bridge: true,
        direct_repository_text_embedded: false
      },
      semantic_input: semanticInput,
      trust: {
        repository_content_instruction_authority: false,
        semantic_input_may_contain_untrusted_repository_data: true
      }
    }
  });
}

test('UA project-scanner Host Task identity ignores disposable projectRoot', () => {
  const first = task('ua:project-scanner', 1, 'C:\\Temp\\relay-A\\views\\understand-anything', {
    scan: { scriptCompleted: true, files: [], stats: { byLanguage: { java: 1 } } },
    outputLanguage: 'ja',
    upstreamAgent: 'project-scanner'
  });
  const second = task('ua:project-scanner', 1, 'D:\\Temp\\relay-B\\views\\understand-anything', {
    scan: { scriptCompleted: true, files: [], stats: { byLanguage: { java: 1 } } },
    outputLanguage: 'ja',
    upstreamAgent: 'project-scanner'
  });

  assert.equal(first.payload.semantic_input.projectRoot, CANONICAL);
  assert.equal(second.payload.semantic_input.projectRoot, CANONICAL);
  assert.equal(first.payload_digest, second.payload_digest);
  assert.equal(first.task_id, second.task_id);
});

test('UA file-analyzer Host Task identity also ignores disposable projectRoot', () => {
  const extra = {
    batchIndex: 1,
    batchFiles: [{ path: 'src/Main.java', language: 'java', sizeLines: 2, fileCategory: 'code' }],
    batchImportData: { 'src/Main.java': [] },
    neighborMap: {},
    extraction: { scriptCompleted: true, results: [] },
    upstreamAgent: 'file-analyzer'
  };
  const first = task('ua:file-analyzer', 2, 'C:\\Temp\\relay-A\\views\\understand-anything', extra);
  const second = task('ua:file-analyzer', 2, 'D:\\Temp\\relay-B\\views\\understand-anything', extra);

  assert.equal(first.payload_digest, second.payload_digest);
  assert.equal(first.task_id, second.task_id);
});

test('non-UA Host Task semantic input is not rewritten', () => {
  const payload = { projectRoot: 'C:\\Temp\\keep-me', value: 1 };
  const projected = projectHostSemanticInput({
    kind: 'kneekura:ARCHITECTURE',
    payload,
    canonicalRepositoryIdentity: CANONICAL
  });
  assert.deepEqual(projected, payload);
});

test('production backend routes Host Task semantic_input through the stable projection', async () => {
  const source = await fs.readFile(new URL('../mcp/src/production-backend.mjs', import.meta.url), 'utf8');
  assert.match(source, /projectHostSemanticInput/);
  assert.match(source, /semantic_input:\s*projectHostSemanticInput\(/);
});
