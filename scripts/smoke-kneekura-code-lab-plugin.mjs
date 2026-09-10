import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { resolveRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createCommitSnapshot } from '../src/core/identity/snapshot.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_PLUGIN_ROOT = path.resolve(
  process.argv[2] ?? path.join(ROOT, 'dist', 'chatgpt-plugin', 'kneekura-code-lab')
);
const EXPECTED_TOOLS = [
  'kneekura_code_lab_describe',
  'kneekura_code_lab_plan',
  'kneekura_code_lab_execute',
  'kneekura_code_lab_next_task',
  'kneekura_code_lab_source_catalog',
  'kneekura_code_lab_read_source',
  'kneekura_code_lab_submit_response',
  'kneekura_code_lab_status',
  'kneekura_code_lab_artifact_info'
];

const isolatedParent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-plugin-isolated-'));
const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-plugin-target-'));
const PLUGIN_ROOT = path.join(isolatedParent, 'kneekura-code-lab');
await fs.cp(SOURCE_PLUGIN_ROOT, PLUGIN_ROOT, { recursive: true });
await assert.rejects(
  () => fs.access(path.join(PLUGIN_ROOT, 'node_modules')),
  error => error?.code === 'ENOENT'
);

const plugin = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
const mcp = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));
assert.equal(plugin.mcpServers, './.mcp.json');
assert.deepEqual(Object.keys(mcp.mcpServers), ['kneekura_code_lab']);
const declaration = mcp.mcpServers.kneekura_code_lab;
assert.equal(declaration.command, 'node');
assert.equal(declaration.cwd, '.');
assert.deepEqual(declaration.args, ['./mcp/server.mjs']);

const serverPath = path.resolve(PLUGIN_ROOT, declaration.args[0]);
assert.equal(serverPath.startsWith(PLUGIN_ROOT + path.sep), true);
await fs.access(serverPath);
await fs.access(path.join(PLUGIN_ROOT, 'mcp', 'prebuilt-human-explorer-shell.json'));

const child = childProcess.spawn(
  declaration.command,
  declaration.args,
  {
    cwd: PLUGIN_ROOT,
    env: cleanEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }
);

const pending = new Map();
let stderr = '';
let nextId = 1;
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    rejectAll(new Error(`non-JSON stdout from generated MCP server: ${text.slice(0, 300)}`));
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    waiter.resolve(message);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr = bounded(stderr + chunk, 8192);
});
child.on('error', error => rejectAll(error));
child.on('exit', (code, signal) => {
  if (pending.size) rejectAll(new Error(`generated MCP server exited early: code=${code} signal=${signal} stderr=${stderr}`));
});

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'kneekura-plugin-smoke', version: '1.0.0' }
  });
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.result.serverInfo.name, 'kneekura-code-lab');
  assert.match(initialized.result.instructions, /HOST_TASK_REQUIRED/);
  notify('notifications/initialized', {});

  const listed = await request('tools/list', {});
  assert.equal(listed.error, undefined);
  const toolNames = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(toolNames, EXPECTED_TOOLS);

  const described = await callTool('kneekura_code_lab_describe', {});
  assert.equal(described.isError, undefined);
  assert.equal(described.value.backend_attached, true);
  assert.equal(described.value.host_bridge_attached, true);
  assert.equal(described.value.hidden_default_engine, false);
  assert.equal(described.value.semantic_fusion, false);

  const invalid = await callTool('kneekura_code_lab_execute', {
    selection: 'kneekura',
    target: {
      repository: 'owner/repository',
      revision: 'a'.repeat(40),
      snapshotId: `snapshot:sha256:${'b'.repeat(64)}`,
      scopeDigest: `sha256:${'c'.repeat(64)}`
    },
    runId: 'plugin-smoke-invalid-target'
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.value.code, 'BLOCKED_TARGET_REPOSITORY_UNAVAILABLE');

  const exact = await createExactTargetFixture(targetRoot);
  const executionRequest = {
    selection: 'kneekura',
    target: {
      repository: targetRoot,
      revision: exact.commit,
      snapshotId: exact.snapshot.snapshot_id,
      scopeDigest: sha256('isolated-plugin-host-bridge-e2e')
    },
    runId: 'plugin-smoke-host-bridge-e2e',
    commonScope: {
      question: 'Explain the exact committed fixture without executing it.'
    }
  };

  const expectedStages = [
    'kneekura:ARCHITECTURE',
    'kneekura:DOMAIN',
    'kneekura:FLOW',
    'kneekura:TOUR',
    'kneekura:REVIEWER'
  ];
  for (const expectedKind of expectedStages) {
    const pendingExecution = await callTool(
      'kneekura_code_lab_execute',
      executionRequest
    );
    assert.equal(pendingExecution.isError, undefined);
    assert.equal(pendingExecution.value.kind, 'HOST_TASK_REQUIRED');
    const task = pendingExecution.value.task;
    assert.equal(task.kind, expectedKind);
    assert.equal(task.snapshot_id, exact.snapshot.snapshot_id);
    assert.equal(task.scope_digest, executionRequest.target.scopeDigest);

    const next = await callTool('kneekura_code_lab_next_task', {
      runId: executionRequest.runId
    });
    assert.equal(next.isError, undefined);
    assert.equal(next.value.pending, true);
    assert.equal(next.value.task.task_id, task.task_id);

    const response = expectedKind === 'kneekura:REVIEWER'
      ? { decisions: [] }
      : { items: [] };
    const submitted = await callTool('kneekura_code_lab_submit_response', {
      runId: executionRequest.runId,
      taskId: task.task_id,
      response
    });
    assert.equal(submitted.isError, undefined);
    assert.equal(submitted.value.accepted, true);
    assert.equal(submitted.value.response_body_exposed, false);
  }

  const completed = await callTool(
    'kneekura_code_lab_execute',
    executionRequest
  );
  assert.equal(completed.isError, undefined);
  assert.equal(completed.value.kind, 'ENGINE_RESULT');
  assert.equal(completed.value.requested_engine, 'kneekura');
  assert.equal(completed.value.receipt.status, 'SUCCESS');
  assert.equal(completed.value.receipt.snapshotId, exact.snapshot.snapshot_id);
  assert.equal(completed.value.artifact_bytes_exposed, false);
  assert.equal(completed.value.sealed_artifact.bytes > 0, true);

  const status = await callTool('kneekura_code_lab_status', {
    runId: executionRequest.runId
  });
  assert.equal(status.isError, undefined);
  assert.equal(status.value.phase, 'COMPLETE');
  assert.equal(status.value.host_task_pending, false);
  assert.equal(status.value.pending_task_id, null);
  assert.equal(status.value.artifacts.length, 1);

  process.stdout.write(
    `KNEEKURA Code LAB generated Plugin MCP smoke: PASS (${toolNames.length} tools; isolated embedded Host Bridge KNEEKURA round-trip verified)\n`
  );
} finally {
  rl.close();
  child.stdin.end();
  if (!child.killed) child.kill();
  await fs.rm(isolatedParent, { recursive: true, force: true });
  await fs.rm(targetRoot, { recursive: true, force: true });
}

async function createExactTargetFixture(root) {
  git(root, ['init']);
  git(root, ['config', 'user.email', 'plugin-smoke@example.invalid']);
  git(root, ['config', 'user.name', 'KNEEKURA Plugin Smoke']);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'Main.java'),
    'package demo;\npublic class Main { int value() { return 1; } }\n',
    'utf8'
  );
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', 'exact plugin smoke target']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const identity = await resolveRepositoryIdentity(root);
  return { commit, snapshot: createCommitSnapshot(identity, commit) };
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function callTool(name, args) {
  const response = await request('tools/call', {
    name,
    arguments: args
  });
  assert.equal(response.error, undefined);
  const content = response.result.content?.[0]?.text;
  assert.equal(typeof content, 'string');
  return {
    isError: response.result.isError,
    value: JSON.parse(content)
  };
}

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP smoke timeout for ${method}; stderr=${stderr}`));
    }, 30000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function rejectAll(error) {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(error);
  }
}

function cleanEnvironment(source) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (source[key] != null) env[key] = String(source[key]);
  }
  return env;
}

function bounded(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(-max);
}