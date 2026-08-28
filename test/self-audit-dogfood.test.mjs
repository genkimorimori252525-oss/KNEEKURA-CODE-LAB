import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  runSelfAudit
} from '../scripts/self-audit.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  return stdout.trim();
}

async function write(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), {
    recursive: true
  });
  await fs.writeFile(file, content, 'utf8');
}

test('self-audit dogfood harness gates a dirty repository against the pinned commit without treating external Node modules as local failures', async t => {
  const root = await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'kneekura-self-audit-fixture-'
    )
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true
    })
  );

  await git(root, ['init']);
  await git(root, [
    'config',
    'user.email',
    'fixture@example.invalid'
  ]);
  await git(root, [
    'config',
    'user.name',
    'Fixture'
  ]);
  await git(root, [
    'remote',
    'add',
    'origin',
    'https://github.com/self-audit-fixture/kneekura-fixture.git'
  ]);

  await write(
    root,
    'src/core/api/analyze.mjs',
    [
      "import path from 'node:path';",
      "import { scan } from '../scan.mjs';",
      'export function analyze() {',
      '  return [path.sep, scan()];',
      '}',
      ''
    ].join('\n')
  );
  await write(
    root,
    'src/core/scan.mjs',
    [
      "import { provider } from './evidence/provider.mjs';",
      'export function scan() {',
      '  return provider;',
      '}',
      ''
    ].join('\n')
  );
  await write(
    root,
    'src/core/evidence/provider.mjs',
    'export const provider = true;\n'
  );
  await write(
    root,
    'src/adapters/jolly-research-mailbox-runner.mjs',
    'export function runMailbox() { return true; }\n'
  );
  await write(
    root,
    'src/analyzers/javascript.mjs',
    'export function analyzeJavaScript() { return true; }\n'
  );

  await git(root, ['add', '.']);
  await git(root, [
    'commit',
    '-m',
    'self audit fixture'
  ]);
  const commit = await git(
    root,
    ['rev-parse', 'HEAD']
  );

  const dirtyPath =
    path.join(
      root,
      'src',
      'core',
      'api',
      'analyze.mjs'
    );
  await fs.writeFile(
    dirtyPath,
    'export function dirtyOnly() { return false; }\n',
    'utf8'
  );

  const statusBefore = await git(
    root,
    ['status', '--porcelain=v1']
  );

  const { report, execution } =
    await runSelfAudit({
      repositoryRoot: root,
      commit
    });

  assert.equal(report.passed, true);
  assert.deepEqual(
    report.failed_gate_ids,
    []
  );
  assert.equal(
    report.target.commit,
    commit
  );
  assert.equal(
    report.canonical.coverage === 'COMPLETE' ||
      report.canonical.coverage === 'BOUNDED' ||
      report.canonical.coverage === 'PARTIAL' ||
      report.canonical.coverage === 'UNKNOWN',
    true
  );

  assert.equal(
    report.javascript.committed_files,
    5
  );
  assert.equal(
    report.javascript.evidence_paths,
    5
  );
  assert.equal(
    report.javascript.unresolved_relative,
    0
  );
  assert.equal(
    report.javascript.unresolved_external >= 1,
    true
  );
  assert.equal(
    report.javascript
      .unresolved_external_targets
      .includes('node:path'),
    true
  );

  assert.ok(
    execution.state.graph.nodes.some(node =>
      node.kind === 'function' &&
      node.key ===
        'src/core/api/analyze.mjs#analyze'
    )
  );
  assert.equal(
    execution.state.graph.nodes.some(node =>
      node.key ===
        'src/core/api/analyze.mjs#dirtyOnly'
    ),
    false
  );

  assert.equal(
    await fs.readFile(dirtyPath, 'utf8'),
    'export function dirtyOnly() { return false; }\n'
  );
  assert.equal(
    await git(root, ['status', '--porcelain=v1']),
    statusBefore
  );
});
