import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCapabilityCoverage,
  classifyRepositoryPath,
  fuseAnalyzerObservations,
  normalizeAnalyzerObservation,
  normalizeProviderManifest,
  profileRepository
} from '../src/analyzer-fabric/index.mjs';

const provider = normalizeProviderManifest({
  id: 'semantic-ts',
  version: '1.0.0',
  supported_languages: ['TYPESCRIPT', 'JAVASCRIPT'],
  capabilities: ['SYNTAX', 'SYMBOL', 'REFERENCE'],
  capability_contracts: [
    { capability: 'SYNTAX', authority_level: 'STRUCTURAL_EVIDENCE', support_status: 'AVAILABLE' },
    { capability: 'SYMBOL', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' },
    { capability: 'REFERENCE', authority_level: 'RESOLVED_SEMANTIC_EVIDENCE', support_status: 'AVAILABLE' }
  ],
  origin: 'EXTERNAL_DETERMINISTIC',
  authority_level: 'RESOLVED_SEMANTIC_EVIDENCE',
  required_tools: [], toolchain_fingerprint: 'ts@test', source_range_support: true,
  semantic_identity_support: true, timeout_ms: 1000, resource_limits: {}, cacheability: true,
  provenance: { source: 'test' }
});

const fallback = normalizeProviderManifest({
  ...provider,
  id: 'fallback-ts',
  capabilities: ['SYNTAX'],
  capability_contracts: [
    { capability: 'SYNTAX', authority_level: 'STRUCTURAL_EVIDENCE', support_status: 'PARTIAL', support_reason: 'fallback-only' }
  ]
});

test('repository profiler detects source/config/build/embedded languages without generic structured-data overclaim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kneekura-profile-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(root, 'data.json'), '{"this":"is data, not proven config"}\n');
  await writeFile(path.join(root, 'README.md'), '```ts\nconst embedded = true\n```\n');
  await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: echo "${{ github.sha }}"\n');
  await writeFile(path.join(root, 'Dockerfile'), 'FROM node:20\nRUN echo hi\n');

  const profile = await profileRepository(root, {
    repositoryId: 'fixture', snapshotId: 'abc', providerManifests: [provider]
  });
  const byPath = new Map(profile.files.map(file => [file.path, file]));
  assert.equal(byPath.get('src/main.ts').primary_language, 'TYPESCRIPT');
  assert.deepEqual(byPath.get('package.json').roles, ['BUILD', 'CONFIG']);
  assert.deepEqual(byPath.get('data.json').roles, ['STRUCTURED_DATA']);
  assert.deepEqual(byPath.get('README.md').embedded_languages, ['TYPESCRIPT']);
  assert.deepEqual(byPath.get('.github/workflows/ci.yml').embedded_languages, ['GITHUB_ACTION_EXPRESSION']);
  assert.deepEqual(byPath.get('Dockerfile').embedded_languages, ['SHELL']);
  assert(profile.coverage.some(item => item.scope.path === 'src/main.ts' && item.capability === 'SYMBOL' && item.support_status === 'AVAILABLE'));
});

test('capability coverage keeps support separate from execution and does not require unused fallback receipt', () => {
  const files = [{ path: 'src/a.ts', primary_language: 'TYPESCRIPT' }];
  const coverage = buildCapabilityCoverage(files, {
    providerManifests: [provider, fallback],
    executionReceipts: [
      { provider_id: 'semantic-ts', path: 'src/a.ts', capability: 'SYNTAX', execution_status: 'ANALYZED' }
    ]
  });
  const syntax = coverage.find(item => item.capability === 'SYNTAX');
  assert.equal(syntax.support_status, 'AVAILABLE');
  assert.equal(syntax.execution_status, 'ANALYZED');
  assert.equal(syntax.provider_refs.find(ref => ref.provider_id === 'fallback-ts').execution_status, undefined);

  const unexploredSymbol = coverage.find(item => item.capability === 'SYMBOL');
  assert.equal(unexploredSymbol.support_status, 'AVAILABLE');
  assert.equal(unexploredSymbol.execution_status, 'UNEXPLORED');
  assert.equal(unexploredSymbol.execution_reason, 'NO_EXECUTION_RECEIPT');
});

test('observation normalizer converts declared UTF-16 positions to exact UTF-8 bytes and preserves provenance', () => {
  const source = 'const 名 = "😀";\nuse(名);\n';
  const observation = normalizeAnalyzerObservation({
    provider_id: 'semantic-ts', provider_version: '1.0.0',
    snapshot: { repository_id: 'repo', snapshot_id: 'sha' },
    capability: 'SYMBOL', observation_type: 'DECLARATION', strength: 'RESOLVED', origin: 'EXTERNAL_DETERMINISTIC',
    subject: { kind: 'variable', display_name: '名', language: 'TYPESCRIPT', signature: 'const 名' },
    source_file: 'src/a.ts',
    source_range: {
      start: { line: 0, column: 6 }, end: { line: 0, column: 7 },
      provider_coordinate_system: 'TS_UTF16', line_base: 0, column_base: 0,
      column_unit: 'UTF16_CODE_UNITS', end_semantics: 'HALF_OPEN'
    },
    provenance: { toolchain_fingerprint: 'ts@test' },
    provider_payload: { native: true }
  }, { sourceTextByPath: { 'src/a.ts': source } });

  assert.equal(observation.source_range.start_byte, 6);
  assert.equal(observation.source_range.end_byte, 9);
  assert.equal(observation.source_range.byte_unit, 'UTF8_BYTES');
  assert.equal(observation.source_range.interval, 'HALF_OPEN');
  assert.equal(observation.provenance.repository_id, 'repo');
  assert.deepEqual(observation.provider_payload, { native: true });
});

test('observation normalizer omits unknown optional ranges, preserves ambiguous native coordinates, and rejects traversal', () => {
  const base = {
    provider_id: 'p', provider_version: '1', snapshot: { repository_id: 'r', snapshot_id: 's' },
    capability: 'SYNTAX', observation_type: 'NODE', strength: 'STRUCTURAL', origin: 'BUILTIN_DETERMINISTIC',
    subject: { kind: 'node', display_name: 'x', language: 'TYPESCRIPT' }, provenance: {}
  };
  const withoutRange = normalizeAnalyzerObservation(base);
  assert.equal(Object.hasOwn(withoutRange, 'source_range'), false);
  assert.equal(Object.hasOwn(withoutRange, 'source_file'), false);

  const inclusive = normalizeAnalyzerObservation({
    ...base,
    source_file: 'src/a.ts',
    source_range: {
      start: { line: 1, column: 1 }, end: { line: 1, column: 1 },
      line_base: 1, column_base: 1, column_unit: 'UNICODE_CODE_POINTS', end_semantics: 'INCLUSIVE'
    }
  }, { sourceTextByPath: { 'src/a.ts': 'x\n' } });
  assert.equal(Object.hasOwn(inclusive.source_range, 'start_byte'), false);
  assert.equal(inclusive.source_range.native_coordinates.end_semantics, 'INCLUSIVE');

  assert.throws(() => normalizeAnalyzerObservation({ ...base, source_file: '../escape.ts' }), /unsafe repository-relative path/);
});

function makeObs(providerId, object, subject = {}) {
  return normalizeAnalyzerObservation({
    provider_id: providerId, provider_version: '1', snapshot: { repository_id: 'r', snapshot_id: 's' },
    capability: 'TYPE', observation_type: 'TYPE_OF', strength: 'RESOLVED', origin: 'EXTERNAL_DETERMINISTIC',
    subject: { kind: 'variable', display_name: 'item', language: 'TYPESCRIPT', ...subject },
    object, provenance: {}
  });
}

test('fusion is provider-order independent, preserves conflicts, and never collapses name-only identities', () => {
  const a = makeObs('a', { type: 'string' });
  const b = makeObs('b', { type: 'number' });
  const forward = fuseAnalyzerObservations([a, b]);
  const reverse = fuseAnalyzerObservations([b, a]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.conflicts.length, 0, 'ambiguous name-only subjects must remain distinct instead of fabricating a conflict on one entity');
  assert.equal(forward.entities.filter(entity => entity.display_name === 'item').length, 2);
  assert.equal(forward.correlation_groups.length, 1);
  assert.equal(forward.correlation_groups[0].reason, 'NAME_ONLY_MATCH_NOT_MERGED');
  assert.equal(forward.invariants.last_writer_wins, false);
});

test('fusion merges exact semantic identities and preserves contradictory evidence as alternatives', () => {
  const subject = {
    kind: 'variable', display_name: 'item', language: 'TYPESCRIPT',
    semantic_symbol_namespace: 'scip-typescript', semantic_symbol_id: 'pkg src/a.ts item.'
  };
  const a = makeObs('a', { type: 'string' }, subject);
  const b = makeObs('b', { type: 'number' }, { ...subject, kind: 'field', display_name: 'renamed-by-provider' });
  const fused = fuseAnalyzerObservations([a, b]);
  const exact = fused.entities.filter(entity => entity.exact_identity);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].observation_refs.length, 2);
  assert.equal(exact[0].display_name, null, 'conflicting provider display names must not be silently canonicalized');
  assert.deepEqual(exact[0].display_name_candidates, ['item', 'renamed-by-provider']);
  assert.equal(exact[0].kind, null, 'conflicting provider kinds must not be silently canonicalized');
  assert.equal(fused.conflicts.length, 1);
  assert.equal(fused.conflicts[0].resolution, 'PRESERVE_ALL');
  assert.equal(fused.conflicts[0].alternatives.length, 2);
});

test('fusion merges language+snapshot+signature+exact-range identity across providers', () => {
  const source = 'const item = 1;\n';
  function one(providerId) {
    return normalizeAnalyzerObservation({
      provider_id: providerId, provider_version: '1', snapshot: { repository_id: 'r', snapshot_id: 's' },
      capability: 'SYMBOL', observation_type: 'DECLARATION', strength: 'RESOLVED', origin: 'EXTERNAL_DETERMINISTIC',
      subject: { kind: 'variable', display_name: 'item', language: 'TYPESCRIPT', signature: 'const item' },
      source_file: 'src/a.ts',
      source_range: { start: { line: 0, column: 6 }, end: { line: 0, column: 10 }, line_base: 0, column_base: 0, column_unit: 'UTF16_CODE_UNITS', end_semantics: 'HALF_OPEN' },
      provenance: {}
    }, { sourceTextByPath: { 'src/a.ts': source } });
  }
  const fused = fuseAnalyzerObservations([one('a'), one('b')]);
  const exact = fused.entities.filter(entity => entity.identity_basis === 'LANGUAGE_SNAPSHOT_SIGNATURE_RANGE_EXACT');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].observation_refs.length, 2);
});

test('path classification keeps generic JSON as structured data while recognizing build/config authority scopes', () => {
  assert.deepEqual(classifyRepositoryPath('random.json').roles, ['STRUCTURED_DATA']);
  assert.deepEqual(classifyRepositoryPath('package.json').roles, ['BUILD', 'CONFIG']);
  assert.deepEqual(classifyRepositoryPath('.github/workflows/test.yaml').roles, ['BUILD', 'CONFIG']);
});


test('non-canonical byte coordinate metadata is preserved as native rather than fabricated into exact identity', () => {
  const source = '😀x\n';
  const base = {
    provider_id: 'p', provider_version: '1', snapshot: { repository_id: 'r', snapshot_id: 's' },
    capability: 'SYNTAX', observation_type: 'NODE', strength: 'STRUCTURAL', origin: 'BUILTIN_DETERMINISTIC',
    subject: { kind: 'node', display_name: 'x', language: 'TYPESCRIPT' }, source_file: 'src/a.ts', provenance: {}
  };
  const inclusive = normalizeAnalyzerObservation({
    ...base, source_range: { start_byte: 1, end_byte: 1, byte_unit: 'UTF8_BYTES', byte_base: 1, end_semantics: 'INCLUSIVE' }
  }, { sourceTextByPath: { 'src/a.ts': source } });
  assert.equal(Object.hasOwn(inclusive.source_range, 'content_digest'), false);
  assert.equal(inclusive.source_range.native_coordinates.byte_base, 1);

  assert.throws(() => normalizeAnalyzerObservation({
    ...base, source_range: { start_byte: 1, end_byte: 4, byte_unit: 'UTF8_BYTES', byte_base: 0, end_semantics: 'HALF_OPEN' }
  }, { sourceTextByPath: { 'src/a.ts': source } }), /UTF-8 code-point boundaries/);
});

test('provenance path conflicts and invalid execution receipts fail closed', () => {
  assert.throws(() => normalizeAnalyzerObservation({
    provider_id: 'p', provider_version: '1', snapshot: { repository_id: 'r', snapshot_id: 's' },
    capability: 'SYNTAX', observation_type: 'NODE', strength: 'STRUCTURAL', origin: 'BUILTIN_DETERMINISTIC',
    subject: { kind: 'node', language: 'TYPESCRIPT' }, source_file: 'src/a.ts', provenance: { path: 'src/b.ts' }
  }), /provenance path conflicts/);

  assert.throws(() => buildCapabilityCoverage([{ path: 'src/a.ts', primary_language: 'TYPESCRIPT' }], {
    providerManifests: [provider],
    executionReceipts: [{ provider_id: 'missing', path: 'src/a.ts', capability: 'SYNTAX', execution_status: 'ANALYZED' }]
  }), /unknown provider/);
});
