import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveRepositoryIdentity } from '../src/core/identity/repository.mjs';
import { createCommitSnapshot } from '../src/core/identity/snapshot.mjs';
import { planKneekuraCodeLabMcpRequest } from '../mcp/src/adapter.mjs';
import { createHostBridgeProductionBackend } from '../mcp/src/production-backend.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_URL = 'https://github.com/genkimorimori252525-oss/KNEEKURA-CODE-LAB';
const revision = String(process.env.GITHUB_SHA || git(ROOT, ['rev-parse', 'HEAD'])).trim().toLowerCase();
assert.match(revision, /^[0-9a-f]{40}$/);
for (const name of ['KNEEKURA_UA_ROOT', 'KNEEKURA_ARCHIFY_ROOT', 'KNEEKURA_ARCHIFY_ARTIFACT_SHA256']) {
  assert(String(process.env[name] ?? '').trim(), `${name} is required`);
}

const repository = await resolveRepositoryIdentity(ROOT);
const snapshot = createCommitSnapshot(repository, revision);
const runId = 'host-bridge-three-engine-ci';
const scopeDigest = digest(`host-bridge-three-engine\0${revision}`);
const plan = planKneekuraCodeLabMcpRequest({
  selection: 'all',
  runId,
  target: {
    repository: ROOT,
    revision,
    snapshotId: snapshot.snapshot_id,
    scopeDigest
  },
  commonScope: {
    question: 'Explain the KNEEKURA Code LAB Host Bridge execution boundary.'
  },
  engineOptions: {
    archify: {
      repositoryUrl: REPOSITORY_URL,
      diagramType: 'architecture',
      quality: 'showcase'
    }
  },
  minimumClaimLevel: {}
});
const backend = createHostBridgeProductionBackend({ env: process.env, tempParent: os.tmpdir() });
const kneekuraOnlyMarker = 'KNEEKURA_ONLY_SEMANTIC_CONTEXT_MARKER_7D4B';
const tasks = [];
let execution = null;

for (let round = 0; round < 600; round += 1) {
  try {
    execution = await backend.execute(plan);
    break;
  } catch (error) {
    if (error?.code !== 'HOST_TASK_REQUIRED' || !error.task) throw error;
    const task = error.task;
    tasks.push({
      task_id: task.task_id,
      engine_id: task.engine_id,
      attempt_id: task.attempt_id,
      ordinal: task.ordinal,
      kind: task.kind,
      payload_digest: task.payload_digest
    });
    if (task.engine_id !== 'kneekura') {
      assert.equal(JSON.stringify(task.payload).includes(kneekuraOnlyMarker), false, 'cross-engine generated analysis leaked into a Host Task');
    }
    const response = await answerTask(task);
    await backend.acceptHostResponse(runId, task.task_id, response);
  }
}

assert(execution, 'Host Bridge three-engine acceptance did not complete');
assert.equal(execution.kind, 'ALL_MODE_BUNDLE');
assert.equal(execution.status, 'SUCCESS');
assert.deepEqual(execution.outcomes.map(row => row.engine_id), [
  'kneekura', 'understand-anything', 'archify'
]);
for (const outcome of execution.outcomes) {
  assert.equal(outcome.status, 'SUCCESS', `${outcome.engine_id} did not succeed`);
  assert.equal(outcome.claim_satisfied, true, `${outcome.engine_id} claim was not satisfied`);
}
assert.equal(new Set(execution.outcomes.map(row => row.semantic_context_id)).size, 3, 'all-mode semantic contexts must stay distinct');
assert(tasks.some(task => task.kind === 'kneekura:ARCHITECTURE'));
assert(tasks.some(task => task.kind === 'ua:project-scanner'));
assert(tasks.some(task => task.kind === 'ua:file-analyzer'));
assert(tasks.some(task => task.kind === 'archify:typed-ir'));

const status = await backend.status(runId);
assert.equal(status.phase, 'COMPLETE');
assert.equal(status.pending_task_id, null);
assert.equal(status.host_bridge.accepted_response_count, tasks.length);
assert.equal(status.artifacts.length, 1);
assert.equal(status.artifacts[0].id, 'all:bundle.zip');

process.stdout.write(JSON.stringify({
  schema: 'kneekura.code-lab.host-bridge-three-engine-acceptance/v1',
  revision,
  snapshot_id: snapshot.snapshot_id,
  scope_digest: scopeDigest,
  status: execution.status,
  host_tasks: tasks.length,
  task_kinds: [...new Set(tasks.map(task => task.kind))],
  semantic_contexts: execution.outcomes.map(row => ({
    engine_id: row.engine_id,
    semantic_context_id: row.semantic_context_id,
    status: row.status,
    claim_level: row.claim_level,
    claim_satisfied: row.claim_satisfied
  })),
  bundle_digest: execution.bundleZipDigest
}, null, 2) + '\n');

async function answerTask(task) {
  const input = task.payload?.semantic_input ?? {};
  if (task.kind === 'kneekura:ARCHITECTURE') {
    const source = await backend.readSource(runId, task.task_id, {
      path: 'mcp/src/server.mjs',
      startLine: 1,
      endLine: 40
    });
    return {
      items: [{
        kind: 'ARCHITECTURE_COMPONENT',
        semantic_class: 'AI_INTERPRETATION',
        title: 'Host Bridge MCP entrypoint',
        body: `The MCP server exposes the explicit Host Bridge round-trip while preserving frozen engine execution. ${kneekuraOnlyMarker}`,
        source_refs: [{
          kind: 'FILE_RANGE',
          path: source.path,
          start_line: source.start_line,
          end_line: source.end_line,
          content_digest: source.content_digest
        }]
      }]
    };
  }
  if (['kneekura:DOMAIN', 'kneekura:FLOW', 'kneekura:TOUR'].includes(task.kind)) {
    return { items: [] };
  }
  if (task.kind === 'kneekura:REVIEWER') {
    return {
      decisions: (input.candidate_items ?? []).map(item => ({
        item_id: item.id,
        status: 'ACCEPT',
        reason: 'Exact-source-linked Host Bridge acceptance item.'
      }))
    };
  }
  if (task.kind.startsWith('ua:')) return answerUa(task.kind.slice(3), input);
  if (task.kind === 'archify:typed-ir') return archifyIr();
  throw new Error(`unsupported Host Task: ${task.kind}`);
}

function answerUa(role, input) {
  if (role === 'project-scanner') {
    return {
      name: 'KNEEKURA Code LAB',
      description: 'Pinned Host Bridge three-engine acceptance target.',
      languages: Object.keys(input.scan?.stats?.byLanguage ?? {}).sort(),
      frameworks: []
    };
  }
  if (role === 'file-analyzer') {
    const nodes = [];
    const edges = [];
    for (const file of input.batchFiles ?? []) {
      const type = nodeType(file);
      nodes.push({
        id: `${type}:${file.path}`,
        type,
        name: file.path.split('/').at(-1),
        filePath: file.path,
        summary: `${file.path} is part of the pinned Host Bridge acceptance snapshot.`,
        tags: ['host-bridge', 'acceptance', file.fileCategory],
        complexity: file.sizeLines > 100 ? 'moderate' : 'simple'
      });
    }
    for (const file of input.batchFiles ?? []) {
      if (file.fileCategory !== 'code') continue;
      for (const target of input.batchImportData?.[file.path] ?? []) {
        edges.push({
          source: `file:${file.path}`,
          target: `file:${target}`,
          type: 'imports',
          direction: 'forward',
          weight: 0.7
        });
      }
    }
    return { nodes, edges };
  }
  if (role === 'assemble-reviewer') return { issues: [], warnings: [] };
  if (role === 'architecture-analyzer') {
    const nodeIds = (input.nodes ?? [])
      .filter(node => ['file','config','document','service','pipeline','table','schema','resource','endpoint'].includes(node.type))
      .map(node => node.id);
    return [{
      id: 'layer:host-bridge',
      name: 'Host Bridge target',
      description: 'All file-level nodes in the exact acceptance snapshot.',
      nodeIds
    }];
  }
  if (role === 'tour-builder') {
    const first = (input.nodes ?? []).find(node => ['file','config','document','service','pipeline','table','schema','resource','endpoint'].includes(node.type));
    return first ? [{
      order: 1,
      title: 'Host Bridge entry',
      description: 'Start from one exact-snapshot file node.',
      nodeIds: [first.id]
    }] : [];
  }
  throw new Error(`unsupported UA role: ${role}`);
}

function archifyIr() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: 'KNEEKURA Code LAB Host Bridge',
      locale: 'en',
      quality_profile: 'showcase',
      repository: { url: REPOSITORY_URL, revision },
      views: [{
        id: 'host-round-trip',
        label: 'Host round trip',
        focus: ['server', 'bridge', 'backend', 'runtime'],
        note: 'Follow one exact-bound semantic task through MCP, Host Bridge replay, and frozen runtime execution.'
      }]
    },
    layout: {
      mode: 'grid', origin: [40, 120], cols: 4,
      gapX: 55, gapY: 90, cellW: 165, cellH: 72
    },
    components: [
      { id: 'server', type: 'frontend', label: 'MCP Server', sublabel: '9-tool surface', row: 0, col: 0, sources: [{ path: 'mcp/src/server.mjs', line: 1 }] },
      { id: 'bridge', type: 'security', label: 'Host Bridge', sublabel: 'exact task binding', row: 0, col: 1, sources: [{ path: 'mcp/src/host-bridge-mcp.mjs', line: 1 }] },
      { id: 'backend', type: 'backend', label: 'Production Backend', sublabel: 'snapshot replay', row: 0, col: 2, sources: [{ path: 'mcp/src/production-backend.mjs', line: 1 }] },
      { id: 'runtime', type: 'database', label: 'Frozen Runtime', sublabel: 'engine receipts', row: 0, col: 3, sources: [{ path: 'src/skill/all-mode.mjs', line: 1 }] }
    ],
    connections: [
      { id: 'server-bridge', from: 'server', to: 'bridge', variant: 'emphasis' },
      { id: 'bridge-backend', from: 'bridge', to: 'backend', variant: 'security' },
      { id: 'backend-runtime', from: 'backend', to: 'runtime', variant: 'emphasis' }
    ],
    cards: [
      { dot: 'rose', title: 'Truth', items: ['Exact snapshot binding', 'No consensus truth promotion'] },
      { dot: 'cyan', title: 'Isolation', items: ['Fresh semantic context per engine', 'No generated-analysis sharing'] },
      { dot: 'emerald', title: 'Replay', items: ['Accepted Host Responses are exact-bound', 'Original engine validators remain authoritative'] }
    ]
  };
}

function nodeType(file) {
  if (file.fileCategory === 'docs') return 'document';
  if (file.fileCategory === 'config') return 'config';
  if (file.fileCategory === 'infra') return file.path.startsWith('.github/workflows/') ? 'pipeline' : 'service';
  if (file.fileCategory === 'data') return 'schema';
  return 'file';
}

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}