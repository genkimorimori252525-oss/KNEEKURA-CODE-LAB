import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAstGrepStructuralProvider,
  createScipSemanticProvider,
  createTreeSitterSyntaxProvider,
  fuseAnalyzerObservations,
  runFabricProvider,
  runFabricProviders
} from '../src/analyzer-fabric/index.mjs';

const repositoryId = 'repo-step011';
const snapshotId = 'sha-step011';
const itemSymbol = 'scip npm fixture 1.0.0 item.';

function context(sourceTextByPath = {}) {
  return { repositoryId, snapshotId, sourceTextByPath };
}

function scipProvider() {
  return createScipSemanticProvider({
    supportedLanguages: ['TYPESCRIPT', 'JAVASCRIPT'],
    toolchainFingerprint: 'scip-typescript@test-1.0.0',
    expectedToolName: 'scip-typescript',
    expectedToolVersion: 'test-1.0.0'
  });
}

test('SCIP provider emits resolved symbols/references and only proves cross-file references when the target is another document', async () => {
  const sourceA = 'export const item = 1;\n';
  const sourceB = 'import { item } from "./a";\nconsole.log(item);\n';
  const provider = scipProvider();
  const index = {
    metadata: { toolInfo: { name: 'scip-typescript', version: 'test-1.0.0' } },
    documents: [
      {
        relativePath: 'src/a.ts',
        language: 'typescript',
        positionEncoding: 'UTF16CodeUnitOffsetFromLineStart',
        occurrences: [
          { range: [0, 13, 17], symbol: itemSymbol, symbolRoles: 1 }
        ],
        symbols: [
          {
            symbol: itemSymbol,
            relationships: [
              { symbol: 'scip npm fixture 1.0.0 ItemType#', isTypeDefinition: true }
            ]
          }
        ]
      },
      {
        relativePath: 'src/b.ts',
        language: 'typescript',
        positionEncoding: 'UTF16CodeUnitOffsetFromLineStart',
        occurrences: [
          { range: [0, 9, 13], symbol: itemSymbol, symbolRoles: 2 },
          { range: [1, 12, 16], symbol: itemSymbol, symbolRoles: 0 }
        ],
        symbols: []
      }
    ],
    externalSymbols: [
      { symbol: 'scip npm fixture 1.0.0 ItemType#' }
    ]
  };

  const run = await runFabricProvider(provider, { index, artifactDigest: 'sha256:fixture' }, context({
    'src/a.ts': sourceA,
    'src/b.ts': sourceB
  }));

  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(run.failures.length, 0);
  assert.equal(run.observations.filter(o => o.capability === 'SYMBOL').length, 1);
  assert.equal(run.observations.filter(o => o.capability === 'REFERENCE').length, 2);
  assert.equal(run.observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE').length, 2);
  assert.equal(run.observations.filter(o => o.capability === 'TYPE').length, 1);
  assert.equal(run.observations.some(o => o.capability === 'CALL'), false);

  const definition = run.observations.find(o => o.observation_type === 'SYMBOL_DEFINITION');
  assert.equal(definition.source_range.start_byte, 13);
  assert.equal(definition.source_range.end_byte, 17);
  assert.equal(definition.subject.semantic_symbol_id, itemSymbol);
  assert.match(definition.subject.semantic_symbol_namespace, /^scip:scip-typescript$/);

  const cross = run.observations.filter(o => o.capability === 'CROSS_FILE_REFERENCE');
  assert.deepEqual(cross.map(o => o.object.target_files), [['src/a.ts'], ['src/a.ts']]);
  assert(cross.every(o => o.strength === 'RESOLVED'));

  const fused = fuseAnalyzerObservations(run.observations);
  const itemEntities = fused.entities.filter(entity => entity.observation_refs.includes(definition.id));
  assert.equal(itemEntities.length, 1);
  assert(itemEntities[0].observation_refs.length >= 6);
});



test('SCIP toolchain mismatch fails typed and isolated instead of accepting stale semantic authority', async () => {
  const provider = scipProvider();
  const index = {
    metadata: { toolInfo: { name: 'scip-typescript', version: 'wrong-version' } },
    documents: []
  };
  const run = await runFabricProvider(provider, { index }, context());
  assert.equal(run.execution_status, 'FAILED');
  assert.equal(run.observations.length, 0);
  assert.equal(run.failures[0].failure_type, 'ANALYZER_TOOLCHAIN_MISMATCH');
});

test('SCIP local symbols are scoped by document and never collapse across files', async () => {
  const provider = scipProvider();
  const index = {
    metadata: { toolInfo: { name: 'scip-typescript', version: 'test-1.0.0' } },
    documents: [
      {
        relativePath: 'src/a.ts', language: 'typescript', positionEncoding: 2,
        occurrences: [{ range: [0, 0, 1], symbol: 'local 0', symbolRoles: 1 }], symbols: []
      },
      {
        relativePath: 'src/b.ts', language: 'typescript', positionEncoding: 2,
        occurrences: [{ range: [0, 0, 1], symbol: 'local 0', symbolRoles: 1 }], symbols: []
      }
    ]
  };
  const run = await runFabricProvider(provider, { index }, context({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }));
  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(run.observations.length, 2);
  assert.notEqual(run.observations[0].subject.semantic_symbol_namespace, run.observations[1].subject.semantic_symbol_namespace);
  const fused = fuseAnalyzerObservations(run.observations);
  assert.equal(fused.entities.filter(entity => entity.exact_identity).length, 2);
});

test('SCIP unspecified position encoding never fabricates an exact source range', async () => {
  const provider = scipProvider();
  const index = {
    metadata: { toolInfo: { name: 'scip-typescript', version: 'test-1.0.0' } },
    documents: [
      {
        relativePath: 'src/a.ts', language: 'typescript',
        occurrences: [{ range: [0, 0, 1], symbol: itemSymbol, symbolRoles: 1 }], symbols: []
      }
    ]
  };
  const run = await runFabricProvider(provider, { index }, context({ 'src/a.ts': 'x\n' }));
  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(Object.hasOwn(run.observations[0], 'source_range'), false);
  assert.deepEqual(run.observations[0].raw_provider_ref, { document: 'src/a.ts', occurrence_index: 0 });
});

test('Tree-sitter provider emits syntax-only structural evidence and strips semantic-looking provider payload fields', async () => {
  const source = 'function f() {}\n';
  const provider = createTreeSitterSyntaxProvider({
    supportedLanguages: ['TYPESCRIPT'],
    toolchainFingerprint: 'tree-sitter-typescript@test-1.0.0'
  });
  const tree = {
    type: 'program', named: true, startIndex: 0, endIndex: Buffer.byteLength(source),
    children: [
      {
        type: 'function_declaration', named: true, startIndex: 0, endIndex: Buffer.byteLength(source) - 1,
        semantic_symbol_id: 'must-not-cross-boundary',
        children: [
          { type: 'function', named: false, startIndex: 0, endIndex: 8 }
        ]
      }
    ]
  };
  const run = await runFabricProvider(provider, { file: 'src/a.ts', language: 'typescript', tree }, context({ 'src/a.ts': source }));
  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(run.observations.length, 2);
  assert(run.observations.every(o => o.capability === 'SYNTAX'));
  assert(run.observations.every(o => o.strength === 'STRUCTURAL'));
  assert(run.observations.every(o => !Object.hasOwn(o.subject, 'semantic_symbol_id')));
  assert(run.observations.every(o => !['REFERENCE', 'CROSS_FILE_REFERENCE', 'CALL'].includes(o.capability)));
  assert.equal(run.observations[0].source_range.content_digest.startsWith('sha256:'), true);
  assert.equal(provider.manifest.semantic_identity_support, false);
});

test('ast-grep adapter remains lower-authority structural FRAMEWORK/CONFIG evidence with exact documented byte offsets', async () => {
  const source = 'register(foo);\n';
  const provider = createAstGrepStructuralProvider({
    supportedLanguages: ['TYPESCRIPT'],
    toolchainFingerprint: 'ast-grep@test-1.0.0',
    ruleCapabilities: { 'forge-register': 'FRAMEWORK' }
  });
  const run = await runFabricProvider(provider, {
    matches: [
      {
        ruleId: 'forge-register', file: 'src/a.ts', language: 'TypeScript', text: 'register',
        range: { byteOffset: { start: 0, end: 8 }, start: { line: 0, column: 0 }, end: { line: 0, column: 8 } }
      }
    ]
  }, context({ 'src/a.ts': source }));

  assert.equal(run.execution_status, 'ANALYZED');
  assert.equal(run.observations.length, 1);
  assert.equal(run.observations[0].capability, 'FRAMEWORK');
  assert.equal(run.observations[0].strength, 'STRUCTURAL');
  assert.equal(run.observations[0].source_range.start_byte, 0);
  assert.equal(run.observations[0].source_range.end_byte, 8);
  assert.equal(provider.manifest.authority_level, 'STRUCTURAL_EVIDENCE');
  assert.equal(provider.manifest.semantic_identity_support, false);
});

test('provider failure is isolated: a structural trust-boundary violation cannot erase successful syntax evidence', async () => {
  const source = 'const x = 1;\n';
  const syntaxProvider = createTreeSitterSyntaxProvider({
    supportedLanguages: ['TYPESCRIPT'],
    toolchainFingerprint: 'tree-sitter-typescript@test-1.0.0'
  });
  const structuralProvider = createAstGrepStructuralProvider({
    supportedLanguages: ['TYPESCRIPT'],
    toolchainFingerprint: 'ast-grep@test-1.0.0',
    ruleCapabilities: { suspicious: 'FRAMEWORK' }
  });

  const aggregate = await runFabricProviders([
    {
      provider: syntaxProvider,
      input: { file: 'src/a.ts', language: 'typescript', nodes: [{ type: 'lexical_declaration', named: true, startIndex: 0, endIndex: 12 }] }
    },
    {
      provider: structuralProvider,
      input: { matches: [{ ruleId: 'suspicious', capability: 'REFERENCE', file: 'src/a.ts', language: 'TypeScript', range: { byteOffset: { start: 0, end: 5 } } }] }
    }
  ], context({ 'src/a.ts': source }));

  assert.equal(aggregate.execution_status, 'PARTIAL');
  assert.equal(aggregate.observations.length, 1);
  assert.equal(aggregate.observations[0].capability, 'SYNTAX');
  assert.equal(aggregate.failures.length, 1);
  assert.equal(aggregate.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');
  assert.equal(aggregate.results[0].execution_status, 'ANALYZED');
  assert.equal(aggregate.results[1].execution_status, 'FAILED');
});

test('SCIP implementation relationships are semantic evidence but remain separate observations, not canonical truth', async () => {
  const provider = scipProvider();
  const dog = 'scip npm fixture 1.0.0 Dog#';
  const animal = 'scip npm fixture 1.0.0 Animal#';
  const index = {
    metadata: { toolInfo: { name: 'scip-typescript', version: 'test-1.0.0' } },
    documents: [
      {
        relativePath: 'src/dog.ts', language: 'typescript', positionEncoding: 2,
        occurrences: [{ range: [0, 6, 9], symbol: dog, symbolRoles: 1 }],
        symbols: [{ symbol: dog, relationships: [{ symbol: animal, isImplementation: true }] }]
      }
    ],
    externalSymbols: [{ symbol: animal }]
  };
  const run = await runFabricProvider(provider, { index }, context({ 'src/dog.ts': 'class Dog {}\n' }));
  const relation = run.observations.find(o => o.capability === 'INHERITANCE');
  assert(relation);
  assert.equal(relation.observation_type, 'IMPLEMENTATION_RELATION');
  assert.equal(relation.strength, 'RESOLVED');
  assert.equal(relation.object.semantic_symbol_id, animal);
  assert.equal(provider.manifest.capability_contracts.find(c => c.capability === 'INHERITANCE').support_status, 'PARTIAL');
});
