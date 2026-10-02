import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFabricProvider,
  createTreeSitterSyntaxProvider,
  runFabricProvider,
  runFabricProviders
} from '../src/analyzer-fabric/index.mjs';

const context = { repositoryId: 'repo-current', snapshotId: 'snapshot-current' };
const manifest = createTreeSitterSyntaxProvider({
  supportedLanguages: ['TYPESCRIPT'],
  toolchainFingerprint: 'tree-sitter@fixture'
}).manifest;

function observation() {
  return {
    provider_id: manifest.id,
    provider_version: manifest.version,
    snapshot: { repository_id: context.repositoryId, snapshot_id: context.snapshotId },
    capability: 'SYNTAX',
    observation_type: 'SYNTAX_NODE',
    subject: { kind: 'identifier', display_name: 'value', language: 'TYPESCRIPT' },
    strength: 'STRUCTURAL',
    origin: manifest.origin,
    provenance: { toolchain_fingerprint: manifest.toolchain_fingerprint },
    provider_payload: { type: 'identifier' }
  };
}

function fixtureProvider(raw, providerManifest = manifest) {
  return createFabricProvider({ manifest: providerManifest, analyze: async () => [raw] });
}

test('matching provider and snapshot bindings preserve successful observations', async () => {
  const run = await runFabricProvider(fixtureProvider(observation()), {}, context);
  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(run.failures.length, 0);
  assert.equal(run.observations.length, 1);
  assert.deepEqual(run.observations[0].provider_payload, { type: 'identifier' });
  assert.deepEqual(run.observations[0].snapshot, {
    repository_id: context.repositoryId, snapshot_id: context.snapshotId
  });
});

test('omitted observation snapshot can inherit the supplied execution context', async () => {
  const raw = observation();
  delete raw.snapshot;
  const run = await runFabricProvider(fixtureProvider(raw), {}, {
    repository_id: context.repositoryId, snapshot_id: context.snapshotId
  });
  assert.equal(run.execution_status, 'ANALYZED');
  assert.deepEqual(run.observations[0].snapshot, {
    repository_id: context.repositoryId, snapshot_id: context.snapshotId
  });
});

const mismatches = [
  ['provider ID', raw => { raw.provider_id = 'scip-semantic'; }],
  ['provider version', raw => { raw.provider_version = '99'; }],
  ['repository identity', raw => { raw.snapshot.repository_id = 'another-repo'; }],
  ['snapshot identity', raw => { raw.snapshot.snapshot_id = 'stale-snapshot'; }],
  ['provider origin', raw => { raw.origin = 'RUNTIME'; }],
  ['undeclared capability', raw => { raw.capability = 'CROSS_FILE_REFERENCE'; }],
  ['toolchain fingerprint', raw => { raw.provenance.toolchain_fingerprint = 'another-toolchain'; }]
];

for (const [name, change] of mismatches) {
  test(`provider runner rejects conflicting ${name} without relabeling the result`, async () => {
    const raw = observation();
    change(raw);
    const run = await runFabricProvider(fixtureProvider(raw), {}, context);
    assert.equal(run.execution_status, 'FAILED');
    assert.deepEqual(run.observations, []);
    assert.equal(run.failures.length, 1);
    assert.equal(run.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');
    assert.equal(run.failures[0].provider_id, manifest.id);
    assert.equal(run.failures[0].provider_version, manifest.version);
  });
}

test('declared but unsupported capability cannot emit successful observations', async () => {
  const disabled = {
    ...manifest,
    capability_contracts: [{ ...manifest.capability_contracts[0], support_status: 'NONE' }]
  };
  const run = await runFabricProvider(fixtureProvider(observation(), disabled), {}, context);
  assert.equal(run.execution_status, 'FAILED');
  assert.equal(run.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');
  assert.deepEqual(run.observations, []);
});

test('a failed provider binding leaves independent successful provider evidence intact', async () => {
  const raw = observation();
  raw.snapshot.snapshot_id = 'stale-snapshot';
  const aggregate = await runFabricProviders([
    { provider: fixtureProvider(raw), input: {} },
    { provider: fixtureProvider(observation()), input: {} }
  ], context);
  assert.equal(aggregate.execution_status, 'PARTIAL');
  assert.equal(aggregate.failures.length, 1);
  assert.equal(aggregate.observations.length, 1);
  assert.equal(aggregate.observations[0].snapshot.snapshot_id, context.snapshotId);
});

test('provider callback cannot change the execution snapshot used for acceptance', async () => {
  const mutableContext = { ...context };
  const provider = createFabricProvider({
    manifest,
    analyze: async (_input, suppliedContext) => {
      suppliedContext.snapshotId = 'stale-snapshot';
      const raw = observation();
      raw.snapshot.snapshot_id = suppliedContext.snapshotId;
      return [raw];
    }
  });
  const run = await runFabricProvider(provider, {}, mutableContext);
  assert.equal(run.execution_status, 'FAILED');
  assert.equal(run.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');
  assert.equal(run.failures[0].provenance.snapshot_id, context.snapshotId);
});

test('non-binding manifest metadata cannot break aggregate provider failure isolation', async () => {
  const withDiagnostic = {
    ...manifest,
    provenance: { ...manifest.provenance, diagnostic: () => 'debug metadata' }
  };
  const stale = observation();
  stale.snapshot.snapshot_id = 'stale-snapshot';
  const aggregate = await runFabricProviders([
    { provider: fixtureProvider(observation()), input: {} },
    { provider: fixtureProvider(stale, withDiagnostic), input: {} }
  ], context);
  assert.equal(aggregate.execution_status, 'PARTIAL');
  assert.equal(aggregate.observations.length, 1);
  assert.equal(aggregate.failures.length, 1);
  assert.equal(aggregate.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');

  const valid = await runFabricProvider(fixtureProvider(observation(), withDiagnostic), {}, context);
  assert.equal(valid.execution_status, 'ANALYZED');
  assert.equal(valid.observations.length, 1);
});
