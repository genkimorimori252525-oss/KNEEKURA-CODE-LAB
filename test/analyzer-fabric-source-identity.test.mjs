import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { normalizeAnalyzerObservation, normalizeSourceRange } from '../src/analyzer-fabric/observation.mjs';
import { fuseAnalyzerObservations, resolveIdentityCandidate } from '../src/analyzer-fabric/fusion.mjs';
import { createFabricProvider, runFabricProvider } from '../src/analyzer-fabric/providers/common.mjs';

const source = '😀x\r\n名😀target();\r\n';
const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const contentDigest = digest(source);
const staleDigest = digest('😀x\r\n名😀changed();\r\n');
const file = 'src/methods.ts';
const context = {
  repositoryId: 'range-repo', snapshotId: 'range-snapshot',
  sourceTextByPath: { [file]: source }
};

function lineRange(columnUnit = 'UTF16_CODE_UNITS') {
  const column = columnUnit === 'UTF8_BYTES' ? 7 : 3;
  return {
    start: { line: 1, column }, end: { line: 1, column: column + 6 },
    provider_coordinate_system: `TEST_${columnUnit}`, line_base: 0, column_base: 0,
    column_unit: columnUnit, end_semantics: 'HALF_OPEN'
  };
}

const rangeCases = [
  ['UTF-8 byte offsets', { start_byte: 14, end_byte: 20 }],
  ['UTF-8 line/column', lineRange('UTF8_BYTES')],
  ['UTF-16 line/column', lineRange('UTF16_CODE_UNITS')]
];

for (const [label, range] of rangeCases) {
  test(`${label} rejects a provider content digest from stale source`, () => {
    assert.throws(() => normalizeSourceRange({ ...range, content_digest: staleDigest }, {
      sourceText: source, expectedContentDigest: contentDigest
    }), /content digest does not match supplied source text/);
  });

  test(`${label} preserves matching digest and exact bytes after emoji and CRLF`, () => {
    const normalized = normalizeSourceRange({ ...range, content_digest: contentDigest }, {
      sourceText: source, expectedContentDigest: contentDigest
    });
    assert.equal(normalized.content_digest, contentDigest);
    assert.equal(normalized.start_byte, 14);
    assert.equal(normalized.end_byte, 20);
    assert.equal(normalized.byte_unit, 'UTF8_BYTES');
    assert.equal(normalized.byte_base, 0);
    assert.equal(normalized.interval, 'HALF_OPEN');
    assert.equal(normalized.start_line, 2);
    assert.equal(normalized.end_line, 2);
    assert.equal(Buffer.from(source).subarray(normalized.start_byte, normalized.end_byte).toString(), 'target');
  });

  test(`${label} rejects a conflicting expected digest`, () => {
    assert.throws(() => normalizeSourceRange({ ...range, content_digest: contentDigest }, {
      sourceText: source, expectedContentDigest: staleDigest
    }), /digest does not match expected digest/);
  });

  test(`${label} can derive an exact digest when the provider omits it`, () => {
    const normalized = normalizeSourceRange(range, { sourceText: source });
    assert.equal(normalized.content_digest, contentDigest);
    assert.equal(normalized.start_byte, 14);
    assert.equal(normalized.end_byte, 20);
  });

  test(`${label} keeps a declared blank digest native rather than fabricating exact identity`, () => {
    const normalized = normalizeSourceRange({ ...range, content_digest: ' ' }, { sourceText: source });
    assert.equal(Object.hasOwn(normalized, 'content_digest'), false);
    assert.equal(Object.hasOwn(normalized, 'start_byte'), false);
    assert(normalized.native_coordinates);
  });
}

function rawObservation(providerId = 'range-provider', overrides = {}) {
  return {
    provider_id: providerId, provider_version: '1',
    snapshot: { repository_id: context.repositoryId, snapshot_id: context.snapshotId },
    capability: 'REFERENCE', observation_type: 'METHOD_REFERENCE',
    strength: 'RESOLVED', origin: 'EXTERNAL_DETERMINISTIC',
    subject: { kind: 'method', display_name: 'Left.m', language: 'TYPESCRIPT', signature: 'm()' },
    object: { kind: 'method', display_name: 'Right.m', language: 'TYPESCRIPT', signature: 'm()' },
    source_file: file, source_range: { ...lineRange(), content_digest: contentDigest },
    provenance: {}, ...overrides
  };
}

function observation(providerId, overrides = {}) {
  return normalizeAnalyzerObservation(rawObservation(providerId, overrides), context);
}

test('stale line/column source digest becomes a typed provider failure with no admitted observations', async () => {
  const provider = createFabricProvider({
    manifest: {
      id: 'range-provider', version: '1', supported_languages: ['TYPESCRIPT'],
      capabilities: ['REFERENCE'],
      capability_contracts: [{ capability: 'REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' }],
      origin: 'EXTERNAL_DETERMINISTIC', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE',
      required_tools: [], toolchain_fingerprint: 'range@test', source_range_support: true,
      semantic_identity_support: true, timeout_ms: 1000, resource_limits: {}, cacheability: true,
      provenance: { source: 'test' }
    },
    analyze: () => [rawObservation(), rawObservation('range-provider', {
      source_range: { ...lineRange(), content_digest: staleDigest }
    })]
  });
  const run = await runFabricProvider(provider, { file }, context);
  assert.equal(run.execution_status, 'FAILED');
  assert.deepEqual(run.observations, []);
  assert.equal(run.failures.length, 1);
  assert.equal(run.failures[0].failure_type, 'TRUST_BOUNDARY_VIOLATION');
  assert.match(run.failures[0].message, /content digest does not match supplied source text/);
});

test('line/column coordinates without source text retain native positions without exact identity', () => {
  const range = lineRange();
  const normalized = normalizeSourceRange({ ...range, content_digest: contentDigest }, {
    expectedContentDigest: contentDigest
  });
  assert.deepEqual(normalized, { native_coordinates: range });
  const observations = ['a', 'b'].map(id => normalizeAnalyzerObservation(rawObservation(id), {
    repositoryId: context.repositoryId, snapshotId: context.snapshotId
  }));
  const fused = fuseAnalyzerObservations(observations);
  assert.equal(fused.entities.length, 4);
  assert(fused.entities.every(entity => !entity.exact_identity));
});

test('non-half-open line/column coordinates retain native positions without fabricated identity', () => {
  const range = { ...lineRange(), end_semantics: 'INCLUSIVE' };
  const normalized = normalizeSourceRange({ ...range, content_digest: contentDigest }, { sourceText: source });
  assert.deepEqual(normalized, { native_coordinates: range });
});

test('object endpoint cannot borrow the observation source range as exact identity', () => {
  const obs = observation('a');
  const resolved = resolveIdentityCandidate(obs.object, obs, 'object');
  assert.equal(resolved.exact, false);
  assert.equal(resolved.basis, 'AMBIGUOUS_KEEP_SEPARATE');
});

test('same-signature Left.m and Right.m remain distinct reference endpoints', () => {
  const obs = observation('a');
  const fused = fuseAnalyzerObservations([obs]);
  const subject = fused.endpoint_refs.find(ref => ref.role === 'subject');
  const object = fused.endpoint_refs.find(ref => ref.role === 'object');
  assert.notEqual(subject.entity_ref, object.entity_ref);
  assert.equal(fused.entities.length, 2);
  assert.equal(subject.identity_basis, 'LANGUAGE_SNAPSHOT_SIGNATURE_RANGE_EXACT');
  assert.equal(object.identity_basis, 'AMBIGUOUS_KEEP_SEPARATE');
  assert.deepEqual(fused.entities.map(entity => entity.display_name).sort(), ['Left.m', 'Right.m']);
});

test('matching source-range subjects still merge across providers while ambiguous objects stay separate', () => {
  const a = observation('a');
  const b = observation('b', {
    source_range: { ...lineRange('UTF8_BYTES'), content_digest: contentDigest }
  });
  const fused = fuseAnalyzerObservations([a, b]);
  const subjectRefs = fused.endpoint_refs.filter(ref => ref.role === 'subject');
  const objectRefs = fused.endpoint_refs.filter(ref => ref.role === 'object');
  assert.equal(new Set(subjectRefs.map(ref => ref.entity_ref)).size, 1);
  assert.equal(new Set(objectRefs.map(ref => ref.entity_ref)).size, 2);
  assert.equal(fused.entities.length, 3);
  const subject = fused.entities.find(entity => entity.id === subjectRefs[0].entity_ref);
  assert.equal(subject.identity_basis, 'LANGUAGE_SNAPSHOT_SIGNATURE_RANGE_EXACT');
  assert.deepEqual(subject.observation_refs, [a.id, b.id].sort());
  assert.deepEqual(fused, fuseAnalyzerObservations([b, a]));
});

test('a true semantic self-reference keeps both endpoints merged', () => {
  const identity = {
    kind: 'method', display_name: 'Left.m', language: 'TYPESCRIPT', signature: 'm()',
    semantic_symbol_namespace: 'test-semantic', semantic_symbol_id: 'Left#m()'
  };
  const obs = observation('a', { subject: identity, object: identity });
  const fused = fuseAnalyzerObservations([obs]);
  assert.equal(fused.entities.length, 1);
  assert.equal(fused.entities[0].identity_basis, 'SEMANTIC_IDENTITY_EXACT');
  assert.equal(fused.endpoint_refs.length, 2);
  assert.equal(new Set(fused.endpoint_refs.map(ref => ref.entity_ref)).size, 1);
});

test('distinct semantic IDs remain separate despite matching signature and observation range', () => {
  const identity = {
    kind: 'method', display_name: 'm', language: 'TYPESCRIPT', signature: 'm()',
    semantic_symbol_namespace: 'test-semantic'
  };
  const obs = observation('a', {
    subject: { ...identity, semantic_symbol_id: 'Left#m()' },
    object: { ...identity, semantic_symbol_id: 'Right#m()' }
  });
  const fused = fuseAnalyzerObservations([obs]);
  assert.equal(fused.entities.length, 2);
  assert(fused.entities.every(entity => entity.identity_basis === 'SEMANTIC_IDENTITY_EXACT'));
  assert.equal(new Set(fused.endpoint_refs.map(ref => ref.entity_ref)).size, 2);
});
