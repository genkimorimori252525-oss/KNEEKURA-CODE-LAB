import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from '../src/core/scan.mjs';
import { scanWorkspace } from '../src/core/workspace.mjs';
import { validateEvidenceRecordV1 } from '../src/core/schema/v1.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, 'fixtures/forge-mini');
const TRACE = path.join(ROOT, 'fixtures/runtime/kneekura-trace.jsonl');
const CLIENT_NET = path.join(ROOT, 'fixtures/runtime/kneekura-client.net.jsonl');
const WRONG_RUN_NET = path.join(ROOT, 'fixtures/runtime/kneekura-wrong-run.net.jsonl');

test('provider wrappers add canonical Java evidence with snapshot/provider provenance', async () => {
  const graph = await scanRepository(FIXTURE);

  assert.equal(graph.schema, 'kneekura.graph/v1');
  assert.ok((graph.meta.providers?.length ?? 0) > 0);
  assert.ok((graph.meta.evidence?.length ?? 0) > 0);

  for (const record of graph.meta.evidence) {
    assert.equal(validateEvidenceRecordV1(record), record);
    assert.equal(record.provenance.repository_id, graph.meta.repository.repository_id);
    assert.equal(record.provenance.snapshot_id, graph.meta.snapshot.snapshot_id);
    assert.equal(record.provenance.provider_id, record.provider_id);
    assert.equal(record.provenance.provider_version, record.provider_version);
  }

  const javaEvidence = graph.meta.evidence.find(record => record.provider_id === 'builtin-java');
  assert.ok(javaEvidence);
  assert.equal(javaEvidence.kind, 'STATIC_ANALYSIS');
  assert.equal(javaEvidence.trust_class, 'REPOSITORY_UNTRUSTED');
  assert.ok(javaEvidence.provenance.path?.endsWith('.java'));
  assert.equal(Object.hasOwn(javaEvidence.provenance, 'range'), false);
});

test('unresolved Java imports stay explicitly unresolved instead of becoming fabricated exact symbols', async () => {
  const graph = await scanRepository(FIXTURE);
  const unresolved = graph.meta.unresolvedReferences?.find(item =>
    item.provider_id === 'builtin-java' &&
    item.kind === 'IMPORT' &&
    item.target === 'net.minecraftforge.eventbus.api.SubscribeEvent'
  );

  assert.ok(unresolved);
  assert.equal(unresolved.resolution, 'UNRESOLVED');

  const symbol = graph.nodes.find(node =>
    node.kind === 'symbol' &&
    node.key === 'net.minecraftforge.eventbus.api.SubscribeEvent'
  );
  assert.ok(symbol);
  assert.equal(symbol.external, true);
  assert.equal(symbol.resolution, 'UNRESOLVED');
  assert.equal(symbol.unresolved, true);
});

test('runtime network provider emits canonical measured evidence with artifact and run provenance', async () => {
  const graph = await scanRepository(FIXTURE, {
    trace: TRACE,
    network: [CLIENT_NET]
  });

  const traceRecord = graph.meta.evidence?.find(item => item.provider_id === 'runtime-trace-adapter');
  assert.ok(traceRecord);
  assert.equal(traceRecord.provenance.runtime_run_id, 'run-42');

  const record = graph.meta.evidence?.find(item => item.provider_id === 'network-companion-adapter');
  assert.ok(record);
  assert.equal(validateEvidenceRecordV1(record), record);
  assert.equal(record.kind, 'RUNTIME');
  assert.equal(record.trust_class, 'RUNTIME_MEASURED');
  assert.match(record.provenance.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.provenance.runtime_run_id, 'run-42');
  assert.equal(record.observation.runtime_run_id, 'run-42');
  assert.ok(record.observation.receive_event_count > 0);
});

test('runtime-only channel mismatch stays unresolved and does not fabricate a static channel node', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-provider-network-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const network = path.join(dir, 'unknown-channel.net.jsonl');
  await fs.writeFile(network, [
    JSON.stringify({
      v: 1,
      ch: 'net_meta',
      scenario: 'ysm-compat',
      run: 'run-42',
      bound: true,
      physicalSide: 'CLIENT',
      pid: '999',
      startedGameTime: 1000
    }),
    JSON.stringify({
      v: 1,
      ch: 'net',
      seq: 1,
      stage: 'receive',
      physicalSide: 'CLIENT',
      gameTime: 1002,
      thread: 'Render thread',
      packet: 'demo.net.UnknownPacket',
      direction: 'PLAY_TO_CLIENT',
      channel: 'missing:channel'
    })
  ].join('\n') + '\n');

  const graph = await scanRepository(dir, {
    trace: TRACE,
    network: [network]
  });

  const runtimeChannel = graph.nodes.find(node =>
    node.kind === 'runtime_network_channel' &&
    node.resourceId === 'missing:channel'
  );
  assert.ok(runtimeChannel);
  assert.equal(runtimeChannel.unresolvedStaticChannel, true);
  assert.equal(graph.nodes.some(node =>
    node.kind === 'network_channel' &&
    node.resourceId === 'missing:channel'
  ), false);

  const unresolved = graph.meta.unresolvedReferences?.find(item =>
    item.provider_id === 'network-companion-adapter' &&
    item.kind === 'STATIC_NETWORK_CHANNEL' &&
    item.target === 'missing:channel'
  );
  assert.ok(unresolved);
  assert.equal(unresolved.resolution, 'UNRESOLVED');
});

test('runtime companion rejection becomes a typed provider failure rather than no result', async () => {
  const graph = await scanRepository(FIXTURE, {
    trace: TRACE,
    network: [WRONG_RUN_NET]
  });

  const failure = graph.meta.providerFailures?.find(item =>
    item.provider_id === 'network-companion-adapter'
  );
  assert.ok(failure);
  assert.equal(failure.code, 'RUNTIME_IDENTITY_MISMATCH');
  assert.match(failure.message, /mismatch/i);
  assert.equal(
    graph.nodes.some(node =>
      node.kind === 'runtime_network_capture' &&
      node.run !== 'run-42'
    ),
    false
  );
});


test('workspace scan preserves constituent canonical evidence and provenance', async () => {
  const graph = await scanWorkspace([
    { name: 'tlm', root: path.join(ROOT, 'fixtures/workspace/tlm') },
    { name: 'ysm', root: path.join(ROOT, 'fixtures/workspace/ysm') }
  ]);

  assert.equal(graph.schema, 'kneekura.graph/v1');
  assert.ok((graph.meta.evidence?.length ?? 0) > 0);
  assert.ok((graph.meta.providers?.length ?? 0) > 0);
  assert.ok((graph.meta.providerResults?.length ?? 0) > 0);

  const snapshotIds = new Set(
    graph.meta.repositories
      .map(entry => entry.snapshot?.snapshot_id)
      .filter(Boolean)
  );

  for (const record of graph.meta.evidence) {
    assert.equal(validateEvidenceRecordV1(record), record);
    assert.equal(snapshotIds.has(record.provenance.snapshot_id), true);
  }

  assert.equal(
    graph.meta.providerResults.every(item =>
      item.workspace_repository === 'tlm' || item.workspace_repository === 'ysm'
    ),
    true
  );
});


test('directory artifact fingerprint and provenance change when Understand Anything content changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-provider-ua-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const uaDir = path.join(dir, '.ua');
  await fs.mkdir(uaDir, { recursive: true });
  const graphFile = path.join(uaDir, 'knowledge-graph.json');

  const writeGraph = async description => {
    await fs.writeFile(graphFile, JSON.stringify({
      version: 1,
      project: { name: 'ua-fixture', description },
      nodes: [],
      edges: [],
      layers: [],
      tour: []
    }));
  };

  await writeGraph('first');
  const first = await scanRepository(FIXTURE, { understand: dir });
  const firstResult = first.meta.providerResults.find(item =>
    item.provider_id === 'understand-anything-adapter'
  );
  const firstEvidence = first.meta.evidence.find(item =>
    item.provider_id === 'understand-anything-adapter'
  );

  await writeGraph('second');
  const second = await scanRepository(FIXTURE, { understand: dir });
  const secondResult = second.meta.providerResults.find(item =>
    item.provider_id === 'understand-anything-adapter'
  );
  const secondEvidence = second.meta.evidence.find(item =>
    item.provider_id === 'understand-anything-adapter'
  );

  assert.ok(firstResult);
  assert.ok(secondResult);
  assert.ok(firstEvidence);
  assert.ok(secondEvidence);
  assert.match(firstEvidence.provenance.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(secondEvidence.provenance.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(firstResult.dependency_fingerprint, secondResult.dependency_fingerprint);
  assert.notEqual(firstEvidence.provenance.artifact_digest, secondEvidence.provenance.artifact_digest);
});
