import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScipSemanticProvider,
  fuseAnalyzerObservations,
  runFabricProvider
} from '../src/analyzer-fabric/index.mjs';

const globalSymbol = 'scip npm fixture 1.0.0 item.';

function document(path, occurrences) {
  return { relativePath: path, language: 'typescript', positionEncoding: 2, occurrences };
}

function occurrence(symbol, symbolRoles, column = 0) {
  return { range: [0, column, column + 1], symbol, symbolRoles };
}

async function analyze(documents, externalSymbols = []) {
  const provider = createScipSemanticProvider({
    toolchainFingerprint: 'scip-typescript@test-1.0.0',
    expectedToolName: 'scip-typescript',
    expectedToolVersion: 'test-1.0.0'
  });
  const run = await runFabricProvider(provider, {
    index: {
      metadata: { toolInfo: { name: 'scip-typescript', version: 'test-1.0.0' } },
      documents,
      externalSymbols
    }
  }, {
    repositoryId: 'repo-scip-identity',
    snapshotId: 'sha-scip-identity',
    sourceTextByPath: Object.fromEntries(documents.map(doc => [doc.relativePath, 'x x x\n']))
  });
  assert.equal(run.execution_status, 'ANALYZED');
  assert.deepEqual(run.failures, []);
  return run.observations;
}

test('SCIP reused local IDs retain document-local references without cross-file edges', async () => {
  const observations = await analyze(['src/a.ts', 'src/b.ts'].map(path => document(path, [
    occurrence('local 0', 1),
    occurrence('local 0', 0, 2)
  ])));

  assert.equal(observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE').length, 0);
  assert.equal(observations.filter(o => o.capability === 'SYMBOL').length, 2);
  assert.equal(observations.filter(o => o.capability === 'REFERENCE').length, 2);
  const entities = fuseAnalyzerObservations(observations).entities;
  assert.equal(entities.length, 2);
  for (const path of ['src/a.ts', 'src/b.ts']) {
    const localObservations = observations.filter(o => o.source_file === path);
    assert.equal(new Set(localObservations.map(o => o.subject.semantic_symbol_namespace)).size, 1);
    assert(entities.some(entity => localObservations.every(o => entity.observation_refs.includes(o.id))));
  }
});

test('SCIP global symbols retain real cross-file edges alongside reused local IDs', async () => {
  const observations = await analyze([
    document('src/a.ts', [occurrence('local 0', 1), occurrence(globalSymbol, 1, 2)]),
    document('src/b.ts', [occurrence('local 0', 1), occurrence('local 0', 0, 2), occurrence(globalSymbol, 0, 4)])
  ]);

  const cross = observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE');
  assert.equal(cross.length, 1);
  assert.equal(cross[0].source_file, 'src/b.ts');
  assert.equal(cross[0].subject.semantic_symbol_id, globalSymbol);
  assert.equal(cross[0].strength, 'RESOLVED');
  assert.deepEqual(cross[0].object, {
    target_symbol: globalSymbol,
    target_files: ['src/a.ts'],
    external: false
  });
});

test('SCIP local reference without a document-local definition never binds another document', async () => {
  const observations = await analyze([
    document('src/a.ts', [occurrence('local 0', 1)]),
    document('src/b.ts', [occurrence('local 0', 0)])
  ]);

  assert.equal(observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE').length, 0);
  const reference = observations.find(o => o.capability === 'REFERENCE');
  const definition = observations.find(o => o.capability === 'SYMBOL');
  assert.equal(reference.source_file, 'src/b.ts');
  assert.equal(reference.subject.semantic_symbol_id, 'local 0');
  assert.notEqual(reference.subject.semantic_symbol_namespace, definition.subject.semantic_symbol_namespace);
});

test('SCIP external global references remain resolved while local and unlisted symbols stay non-cross-file', async () => {
  const unknownSymbol = 'scip npm fixture 1.0.0 unknown.';
  const observations = await analyze([
    document('src/a.ts', [occurrence(globalSymbol, 0), occurrence('local 0', 0, 2), occurrence(unknownSymbol, 0, 4)])
  ], [{ symbol: globalSymbol }, { symbol: 'local 0' }]);

  assert.equal(observations.filter(o => o.capability === 'REFERENCE').length, 3);
  const cross = observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE');
  assert.equal(cross.length, 1);
  assert.equal(cross[0].strength, 'RESOLVED');
  assert.deepEqual(cross[0].object, {
    target_symbol: globalSymbol,
    target_files: [],
    external: true
  });
});
