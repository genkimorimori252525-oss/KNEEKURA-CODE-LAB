import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ROOT = path.resolve(
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
  } catch (error) {
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

  const described = await request('tools/call', {
    name: 'kneekura_code_lab_describe',
    arguments: {}
  });
  assert.equal(described.error, undefined);
  const description = JSON.parse(described.result.content[0].text);
  assert.equal(description.backend_attached, true);
  assert.equal(description.host_bridge_attached, true);
  assert.equal(description.hidden_default_engine, false);
  assert.equal(description.semantic_fusion, false);

  const blocked = await request('tools/call', {
    name: 'kneekura_code_lab_execute',
    arguments: {
      selection: 'kneekura',
      target: {
        repository: 'owner/repository',
        revision: 'a'.repeat(40),
        snapshotId: `snapshot:sha256:${'b'.repeat(64)}`,
        scopeDigest: `sha256:${'c'.repeat(64)}`
      },
      runId: 'plugin-smoke-run'
    }
  });
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.result.isError, true);
  const blockedPayload = JSON.parse(blocked.result.content[0].text);
  assert.equal(blockedPayload.code, 'BLOCKED_TARGET_REPOSITORY_UNAVAILABLE');

  process.stdout.write(
    `KNEEKURA Code LAB generated Plugin MCP smoke: PASS (${toolNames.length} tools; embedded Host Bridge backend verified)\n`
  );
} finally {
  rl.close();
  child.stdin.end();
  if (!child.killed) child.kill();
}

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP smoke timeout for ${method}; stderr=${stderr}`));
    }, 15000);
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
  // Deliberately omit KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE. The distributed
  // plugin must still attach its embedded production Host Bridge backend.
  return env;
}

function bounded(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(-max);
}