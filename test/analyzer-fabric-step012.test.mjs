import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import {
  createTypeScriptCompilerProvider,
  fabricCoverageToCoreCoverage,
  runFabricProvider,
  runTypeScriptSemanticVertical
} from '../src/analyzer-fabric/index.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ts = require('typescript');

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return stdout.trim();
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-ts-step012-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      jsx: 'preserve',
      noEmit: true,
      skipLibCheck: true
    },
    include: ['src/**/*.ts', 'src/**/*.tsx']
  }, null, 2));
  await fs.writeFile(path.join(root, 'src', 'base.ts'), [
    'export interface User { name: string }',
    'export class Base { greet(user: User) { return user.name; } }',
    'export function helper(value: number) { return value + 1; }',
    ''
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'impl.ts'), [
    "import { Base, helper, type User } from './base.js';",
    'export class Impl extends Base {',
    '  run(user: User) { return helper(user.name.length); }',
    '}',
    ''
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'view.tsx'), [
    "import { Impl } from './impl.js';",
    'export const View = () => <section data-kind="fixture" />;',
    'export const makeImpl = () => new Impl();',
    ''
  ].join('\n'));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'step012@example.invalid']);
  await git(root, ['config', 'user.name', 'Step 012 Fixture']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture']);
  const commit = await git(root, ['rev-parse', 'HEAD']);
  return { root, commit };
}

async function withFixture(fn) {
  const fixture = await createFixture();
  try { await fn(fixture); } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
}

test('TypeScript compiler provider resolves repository-local symbols across TS and TSX without claiming complete coverage', async () => {
  await withFixture(async ({ root, commit }) => {
    const result = await runTypeScriptSemanticVertical({
      rootDirectory: root,
      commitSha: commit,
      typescript: ts,
      expectedTypeScriptVersion: String(ts.version)
    });
    assert.equal(result.execution.execution_status, 'ANALYZED');
    assert.equal(result.execution.failures.length, 0);
    assert(result.summary.typescript_files >= 3);
    assert(result.profile.files.some(file => file.path === 'src/view.tsx'));
    assert(result.execution.observations.some(item => item.capability === 'CROSS_FILE_REFERENCE'));
    assert(result.execution.observations.some(item => item.capability === 'CALL'));
    assert(result.execution.observations.some(item => item.capability === 'TYPE'));
    assert(result.execution.observations.some(item => item.capability === 'INHERITANCE'));
    assert(result.execution.observations.every(item => item.source_range?.content_digest?.startsWith('sha256:')));
    assert(result.execution.observations.every(item => Number.isInteger(item.source_range?.start_byte)));
    assert(result.execution.observations.every(item => Number.isInteger(item.source_range?.end_byte)));
    assert.equal(result.evidence_ledger.claims.length, 0);
    assert.equal(result.summary.canonical_claims, 0);
    assert.equal(result.evidence_ledger.coverage.completeness, 'BOUNDED');
    assert(result.evidence_ledger.coverage.entries.some(entry => entry.reason_code === 'FABRIC_PARTIAL_CAPABILITY'));
  });
});

test('Fabric-to-CORE evidence preserves exact source traceability while projecting CORE line provenance', async () => {
  await withFixture(async ({ root, commit }) => {
    const result = await runTypeScriptSemanticVertical({ rootDirectory: root, commitSha: commit, typescript: ts });
    assert(result.evidence_ledger.evidence.length > 0);
    const record = result.evidence_ledger.evidence.find(item => item.observation?.source_range?.content_digest);
    assert(record);
    assert.equal(record.kind, 'STATIC_ANALYSIS');
    assert(record.observation.source_range.start_byte >= 0);
    assert(record.observation.source_range.end_byte >= record.observation.source_range.start_byte);
    assert(record.provenance.range.start_line >= 1);
    assert(record.provenance.range.end_line >= record.provenance.range.start_line);
    assert.equal(record.provenance.path, record.observation.source_file);
  });
});

test('TypeScript toolchain mismatch becomes a typed provider failure instead of stale semantic evidence', async () => {
  await withFixture(async ({ root }) => {
    const provider = createTypeScriptCompilerProvider({
      typescript: ts,
      expectedTypeScriptVersion: '0.0.0-never-match',
      toolchainFingerprint: 'typescript@0.0.0-never-match'
    });
    const result = await runFabricProvider(provider, { rootDirectory: root, tsconfigPath: 'tsconfig.json' }, {
      repositoryId: `repo:sha256:${'a'.repeat(64)}`,
      snapshotId: `snapshot:sha256:${'b'.repeat(64)}`,
      sourceTextByPath: {}
    });
    assert.equal(result.execution_status, 'FAILED');
    assert.equal(result.observations.length, 0);
    assert.equal(result.failures[0].failure_type, 'ANALYZER_TOOLCHAIN_MISMATCH');
  });
});

test('partial Fabric support maps to an explicit CORE coverage gap rather than COMPLETE', () => {
  const coverage = fabricCoverageToCoreCoverage([
    {
      id: 'coverage:test',
      scope: { type: 'FILE', path: 'src/a.ts' },
      capability: 'REFERENCE',
      support_status: 'PARTIAL',
      execution_status: 'ANALYZED',
      provider_refs: [{ provider_id: 'typescript-compiler-semantic', support_status: 'PARTIAL', execution_status: 'ANALYZED' }],
      support_reason: 'repository-local resolved references only'
    }
  ]);
  assert.equal(coverage.completeness, 'BOUNDED');
  assert.equal(coverage.entries[0].status, 'UNEXPLORED');
  assert.equal(coverage.entries[0].reason_code, 'FABRIC_PARTIAL_CAPABILITY');
});

test('vertical runner refuses a dirty worktree so evidence cannot drift from the frozen commit snapshot', async () => {
  await withFixture(async ({ root, commit }) => {
    await fs.appendFile(path.join(root, 'src', 'base.ts'), '// dirty\n');
    await assert.rejects(
      () => runTypeScriptSemanticVertical({ rootDirectory: root, commitSha: commit, typescript: ts }),
      /ANALYZER_SNAPSHOT_DIRTY/
    );
  });
});
