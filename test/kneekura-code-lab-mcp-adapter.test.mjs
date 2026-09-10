import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  createEngineRunReceipt
} from '../src/skill/index.mjs';
import {
  createKneekuraCodeLabMcpAdapter,
  formatMcpAdapterError,
  planKneekuraCodeLabMcpRequest
} from '../mcp/src/adapter.mjs';
import {
  createInProcessKneekuraCodeLabBackend
} from '../mcp/src/in-process-backend.mjs';

const TARGET = Object.freeze({
  repository: 'owner/repository',
  revision: 'a'.repeat(40),
  snapshotId: `snapshot:sha256:${'b'.repeat(64)}`,
  scopeDigest: `sha256:${'c'.repeat(64)}`
});

function request(selection, runId = 'mcp-test-run') {
  return {
    selection,
    target: { ...TARGET },
    runId,
    commonScope: { question: 'explain architecture' },
    engineOptions: {},
    minimumClaimLevel: {}
  };
}

function makeRunner(engineId, { warning = null, actualEngine = engineId } = {}) {
  return async envelope => {
    const bytes = Buffer.from(`sealed:${actualEngine}`, 'utf8');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const kind = {
      kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
      'understand-anything': 'UA_SKILL_ZIP',
      archify: 'ARCHIFY_SKILL_ZIP'
    }[actualEngine];
    const receipt = createEngineRunReceipt({
      engineId: actualEngine,
      implementationOrigin: actualEngine === 'kneekura'
        ? 'first-party'
        : 'pinned-upstream',
      implementationVersion: 'fixture',
      orchestrationMode: 'native',
      snapshotId: envelope.targetSnapshotId,
      scopeDigest: envelope.scopeDigest,
      attemptId: envelope.attemptId,
      status: 'SUCCESS',
      claimLevel: 'NATIVE',
      claimSatisfied: true,
      acceptance: { fixture: true },
      coverage: { files: 1 },
      artifacts: [{ kind, digest, bytes: bytes.length }],
      warnings: warning ? [warning] : [],
      errors: []
    });
    return actualEngine === 'kneekura'
      ? {
          engineId: actualEngine,
          receipt,
          artifact: {
            zip_bytes: bytes,
            zip_digest: digest,
            privateSource: 'must never reach MCP projection'
          }
        }
      : {
          engineId: actualEngine,
          receipt,
          deliveryZip: bytes,
          deliveryZipDigest: digest,
          privateSource: 'must never reach MCP projection'
        };
  };
}

test('MCP plan requires immutable target identity and keeps engine selection explicit', () => {
  const undecided = planKneekuraCodeLabMcpRequest(request(undefined));
  assert.equal(undecided.kind, 'SELECTION_REQUIRED');
  assert.deepEqual(undecided.choices, [
    'kneekura', 'understand-anything', 'archify'
  ]);

  const planned = planKneekuraCodeLabMcpRequest(request('all'));
  assert.equal(planned.kind, 'RUN');
  assert.deepEqual(planned.requestedEngines, [
    'kneekura', 'understand-anything', 'archify'
  ]);
  assert.equal(planned.target.revision, TARGET.revision);
  assert.equal(planned.invariants.engine_substitution_forbidden, true);
  assert.equal(planned.invariants.semantic_fusion, false);
  assert.equal(planned.invariants.target_instruction_authority, false);
});

test('MCP plan rejects moving refs, fake snapshots, extra fields and oversized input', () => {
  assert.throws(
    () => planKneekuraCodeLabMcpRequest({
      ...request('kneekura'),
      target: { ...TARGET, revision: 'main' }
    }),
    /exact 40- or 64-hex Git revision/
  );
  assert.throws(
    () => planKneekuraCodeLabMcpRequest({
      ...request('kneekura'),
      target: { ...TARGET, snapshotId: 'snapshot:HEAD' }
    }),
    /snapshot:sha256/
  );
  assert.throws(
    () => planKneekuraCodeLabMcpRequest({
      ...request('kneekura'),
      surprise: true
    }),
    /unsupported field/
  );
  assert.throws(
    () => planKneekuraCodeLabMcpRequest({
      ...request('kneekura'),
      commonScope: { text: 'x'.repeat(140 * 1024) }
    }),
    error => error?.code === 'MCP_REQUEST_TOO_LARGE'
  );
});

test('MCP execute fails closed when no execution backend is attached', async () => {
  const adapter = createKneekuraCodeLabMcpAdapter();
  assert.equal(adapter.describe().backend_attached, false);
  await assert.rejects(
    () => adapter.execute(request('kneekura')),
    error => error?.code === 'BLOCKED_BACKEND_UNAVAILABLE'
  );
});

test('in-process backend delegates to frozen runtime and MCP projection exposes receipts, not raw engine data', async () => {
  const seen = [];
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  const backend = createInProcessKneekuraCodeLabBackend({
    async createEngineRunners(context) {
      seen.push(context);
      return {
        kneekura: makeRunner('kneekura', {
          warning: `accidental token ${secret}`
        })
      };
    }
  });
  const adapter = createKneekuraCodeLabMcpAdapter({ backend });
  const result = await adapter.execute(request('kneekura', 'direct-safe-run'));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].target.snapshotId, TARGET.snapshotId);
  assert.deepEqual(seen[0].requestedEngines, ['kneekura']);
  assert.equal(result.kind, 'ENGINE_RESULT');
  assert.equal(result.requested_engine, 'kneekura');
  assert.equal(result.receipt.status, 'SUCCESS');
  assert.equal(result.raw_engine_result_exposed, false);
  assert.equal(result.artifact_bytes_exposed, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('must never reach MCP projection'), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('[REDACTED_GITHUB_TOKEN]'), true);
  assert.equal(containsBuffer(result), false);

  const status = await adapter.status({ runId: 'direct-safe-run' });
  assert.equal(status.found, true);
  assert.equal(status.phase, 'COMPLETE');
  assert.equal(status.artifacts.length, 1);
  assert.equal(status.artifacts[0].id, 'kneekura:result.zip');

  const artifacts = await adapter.artifactInfo({ runId: 'direct-safe-run' });
  assert.equal(artifacts.artifact_bytes_exposed, false);
  assert.equal(artifacts.artifacts.length, 1);
  assert.match(artifacts.artifacts[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal('bytes_buffer' in artifacts.artifacts[0], false);

  await assert.rejects(
    () => adapter.execute(request('kneekura', 'direct-safe-run')),
    error => error?.code === 'RUN_ID_ALREADY_EXISTS'
  );
});

test('all-mode MCP projection preserves engine isolation failures and never promotes consensus', async () => {
  const backend = createInProcessKneekuraCodeLabBackend({
    async createEngineRunners() {
      return {
        kneekura: makeRunner('kneekura'),
        'understand-anything': makeRunner('understand-anything', {
          actualEngine: 'archify'
        }),
        archify: makeRunner('archify')
      };
    }
  });
  const adapter = createKneekuraCodeLabMcpAdapter({ backend });
  const result = await adapter.execute(request('all', 'all-isolated-run'));

  assert.equal(result.kind, 'ALL_MODE_BUNDLE');
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.comparison.semantic_fusion, false);
  assert.equal(result.comparison.canonical_truth_promotion, false);
  assert.equal(
    result.outcomes.find(row => row.engine_id === 'understand-anything').error.code,
    'ENGINE_SUBSTITUTION_FORBIDDEN'
  );
  assert.equal(result.raw_engine_results_exposed, false);
  assert.equal(result.artifact_bytes_exposed, false);
  assert.equal(containsBuffer(result), false);
});

test('MCP error projection redacts diagnostics and artifact metadata forbids file paths', async () => {
  const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
  const error = new Error(`backend leaked ${secret}`);
  error.code = 'BACKEND_TEST';
  const projected = formatMcpAdapterError(error);
  assert.equal(JSON.stringify(projected).includes(secret), false);

  const adapter = createKneekuraCodeLabMcpAdapter({
    backend: {
      async execute() { throw error; },
      async status() {
        return { phase: 'COMPLETE', artifacts: [] };
      },
      async artifactInfo() {
        return [{
          id: 'kneekura:result.zip',
          digest: `sha256:${'d'.repeat(64)}`,
          bytes: 10,
          uri: 'file:///secret/path/result.zip'
        }];
      }
    }
  });
  await assert.rejects(
    () => adapter.artifactInfo({ runId: 'artifact-uri-run' }),
    /https: or kneekura-code-lab:/
  );
});

function containsBuffer(value) {
  if (Buffer.isBuffer(value)) return true;
  if (Array.isArray(value)) return value.some(containsBuffer);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsBuffer);
  }
  return false;
}