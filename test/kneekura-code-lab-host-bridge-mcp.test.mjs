import assert from 'node:assert/strict';
import test from 'node:test';

import { createKneekuraCodeLabMcpAdapter } from '../mcp/src/adapter.mjs';
import { createHostTask, createHostResponseRecord } from '../mcp/src/host-bridge-contract.mjs';
import { createHostBridgeMcpFacade, HOST_BRIDGE_MCP_TOOL_NAMES } from '../mcp/src/host-bridge-mcp.mjs';

const RUN_ID = 'host-bridge-mcp-test';
const SNAPSHOT_ID = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE_DIGEST = `sha256:${'c'.repeat(64)}`;
const TASK = createHostTask({
  runId: RUN_ID,
  engineId: 'kneekura',
  attemptId: 'attempt-test-1-kneekura',
  snapshotId: SNAPSHOT_ID,
  scopeDigest: SCOPE_DIGEST,
  ordinal: 1,
  kind: 'kneekura:ARCHITECTURE',
  payload: {
    schema: 'fixture/v1',
    instruction_authority: false,
    request: 'Describe the architecture.'
  }
});

function executionRequest() {
  return {
    selection: 'kneekura',
    runId: RUN_ID,
    target: {
      repository: 'owner/repository',
      revision: 'a'.repeat(40),
      snapshotId: SNAPSHOT_ID,
      scopeDigest: SCOPE_DIGEST
    },
    commonScope: {},
    engineOptions: {},
    minimumClaimLevel: {}
  };
}

function fixtureBackend() {
  let pending = TASK;
  let accepted = null;
  return {
    async execute() {
      const error = new Error('host response required');
      error.code = 'HOST_TASK_REQUIRED';
      error.task = pending;
      throw error;
    },
    async status() {
      return {
        phase: 'PENDING',
        summary: 'Host semantic response required.',
        artifacts: []
      };
    },
    async artifactInfo() { return []; },
    async pendingTask(runId) {
      assert.equal(runId, RUN_ID);
      return pending;
    },
    async sourceCatalog(runId, taskId, { offset, limit }) {
      assert.equal(runId, RUN_ID);
      assert.equal(taskId, TASK.task_id);
      assert.equal(offset, 0);
      assert.equal(limit, 10);
      return {
        total: 1,
        offset: 0,
        next_offset: null,
        entries: [{
          path: 'src/Main.java',
          content_digest: `sha256:${'d'.repeat(64)}`,
          line_count: 3,
          bytes: 80,
          instruction_authority: false
        }]
      };
    },
    async readSource(runId, taskId, request) {
      assert.equal(runId, RUN_ID);
      assert.equal(taskId, TASK.task_id);
      assert.deepEqual(request, {
        path: 'src/Main.java',
        startLine: 1,
        endLine: 3
      });
      return {
        path: 'src/Main.java',
        start_line: 1,
        end_line: 3,
        content_digest: `sha256:${'d'.repeat(64)}`,
        text: 'class Main { String token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"; }',
        instruction_authority: false,
        trust_class: 'UNTRUSTED_REPOSITORY_DATA',
        canonical_source_bytes: 80,
        task_source_bytes_used: 80,
        task_source_bytes_limit: 1024
      };
    },
    async acceptHostResponse(runId, taskId, response) {
      assert.equal(runId, RUN_ID);
      assert.equal(taskId, TASK.task_id);
      accepted = createHostResponseRecord({ task: TASK, response });
      pending = null;
      return accepted;
    },
    get accepted() { return accepted; }
  };
}

test('Host Bridge MCP facade keeps legacy adapter calls and exposes nine truthful tools', async () => {
  const backend = fixtureBackend();
  const adapter = createKneekuraCodeLabMcpAdapter({ backend });
  const bridge = createHostBridgeMcpFacade({ adapter, backend });

  const description = bridge.describe();
  assert.deepEqual(description.tools, HOST_BRIDGE_MCP_TOOL_NAMES);
  assert.equal(description.backend_attached, true);
  assert.equal(description.host_bridge_attached, true);
  assert.equal(description.multi_round_host_semantics, true);

  const planned = bridge.plan(executionRequest());
  assert.equal(planned.kind, 'RUN');
  const pending = await bridge.execute(executionRequest());
  assert.equal(pending.kind, 'HOST_TASK_REQUIRED');
  assert.equal(pending.task.task_id, TASK.task_id);
  assert.equal(pending.task.engine_id, 'kneekura');
  assert.equal(pending.task.snapshot_id, SNAPSHOT_ID);
  assert.equal(pending.task.scope_digest, SCOPE_DIGEST);

  const next = await bridge.nextTask({ runId: RUN_ID });
  assert.equal(next.pending, true);
  assert.equal(next.task.task_id, TASK.task_id);

  const status = await bridge.status({ runId: RUN_ID });
  assert.equal(status.phase, 'PENDING');
  assert.equal(status.host_task_pending, true);
  assert.equal(status.pending_task_id, TASK.task_id);

  const catalog = await bridge.sourceCatalog({
    runId: RUN_ID,
    taskId: TASK.task_id,
    offset: 0,
    limit: 10
  });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].path, 'src/Main.java');
  assert.equal(catalog.entries[0].instruction_authority, false);

  const source = await bridge.readSource({
    runId: RUN_ID,
    taskId: TASK.task_id,
    path: 'src/Main.java',
    startLine: 1,
    endLine: 3
  });
  assert.equal(source.instruction_authority, false);
  assert.equal(source.trust_class, 'UNTRUSTED_REPOSITORY_DATA');
  assert.equal(source.text.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), false);
  assert.match(source.text, /\[REDACTED_GITHUB_TOKEN\]/);

  const submitted = await bridge.submitResponse({
    runId: RUN_ID,
    taskId: TASK.task_id,
    response: { items: [] }
  });
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.task_id, TASK.task_id);
  assert.equal(submitted.response_body_exposed, false);
  assert.equal('response' in submitted, false);
  assert.equal(backend.accepted.response_digest, submitted.response_digest);

  const after = await bridge.nextTask({ runId: RUN_ID });
  assert.equal(after.pending, false);
});

test('Host Bridge MCP facade rejects foreign task bindings and unavailable Host Bridge methods', async () => {
  const foreignBackend = fixtureBackend();
  foreignBackend.execute = async () => {
    const foreign = createHostTask({
      runId: 'foreign-run',
      engineId: 'kneekura',
      attemptId: 'attempt-foreign-1-kneekura',
      snapshotId: SNAPSHOT_ID,
      scopeDigest: SCOPE_DIGEST,
      ordinal: 1,
      kind: 'kneekura:ARCHITECTURE',
      payload: {}
    });
    const error = new Error('foreign');
    error.code = 'HOST_TASK_REQUIRED';
    error.task = foreign;
    throw error;
  };
  const foreignAdapter = createKneekuraCodeLabMcpAdapter({ backend: foreignBackend });
  const foreignBridge = createHostBridgeMcpFacade({ adapter: foreignAdapter, backend: foreignBackend });
  await assert.rejects(
    () => foreignBridge.execute(executionRequest()),
    error => error?.code === 'HOST_TASK_BINDING_MISMATCH'
  );

  const legacyBackend = {
    async execute() { throw new Error('not used'); },
    async status() { return null; },
    async artifactInfo() { return []; }
  };
  const legacyAdapter = createKneekuraCodeLabMcpAdapter({ backend: legacyBackend });
  const legacyBridge = createHostBridgeMcpFacade({ adapter: legacyAdapter, backend: legacyBackend });
  assert.equal(legacyBridge.describe().host_bridge_attached, false);
  await assert.rejects(
    () => legacyBridge.nextTask({ runId: RUN_ID }),
    error => error?.code === 'BLOCKED_HOST_BRIDGE_UNAVAILABLE'
  );
});