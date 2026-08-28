import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scanRepository } from '../src/core/scan.mjs';
import { walk } from '../src/core/walk.mjs';
import { analyzeInternal } from '../src/core/api/analyze.mjs';

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

async function tempDir(t, prefix) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), prefix)
  );
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true
    })
  );
  return root;
}

test('JavaScript lexical provider records local module dependencies, declarations, and unresolved external modules', async t => {
  const root = await tempDir(
    t,
    'kneekura-js-provider-'
  );

  await fs.mkdir(
    path.join(root, 'src'),
    { recursive: true }
  );
  await fs.mkdir(
    path.join(root, 'node_modules', 'ignored'),
    { recursive: true }
  );

  await fs.writeFile(
    path.join(root, 'src', 'main.mjs'),
    [
      "import path from 'node:path';",
      "import { helper } from './dep.mjs';",
      "export { helper as forwarded } from './dep.mjs';",
      "export class Runner extends Base {}",
      "export async function run(value) { return helper(value); }",
      "export const arrow = (value) => value;",
      "const lazy = () => import('./lazy.mjs');",
      "const fsModule = require('node:fs');",
      ''
    ].join('\n'),
    'utf8'
  );

  await fs.writeFile(
    path.join(root, 'src', 'dep.mjs'),
    [
      'export function helper(value) {',
      '  return value;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  await fs.writeFile(
    path.join(root, 'src', 'lazy.mjs'),
    'export const lazyValue = 1;\n',
    'utf8'
  );

  await fs.writeFile(
    path.join(
      root,
      'node_modules',
      'ignored',
      'index.mjs'
    ),
    'export function shouldNotAppear() {}\n',
    'utf8'
  );

  const walked = (await walk(root))
    .map(file =>
      path.relative(root, file).replaceAll('\\', '/')
    )
    .sort();

  assert.deepEqual(
    walked,
    [
      'src/dep.mjs',
      'src/lazy.mjs',
      'src/main.mjs'
    ]
  );

  const graph = await scanRepository(root);

  const main = graph.nodes.find(node =>
    node.kind === 'file' &&
    node.path === 'src/main.mjs'
  );
  assert.ok(main);
  assert.equal(main.language, 'javascript');
  assert.equal(main.moduleType, 'esm');
  assert.deepEqual(
    main.exports,
    [
      'Runner',
      'arrow',
      'forwarded',
      'run'
    ]
  );

  for (const key of [
    'src/main.mjs#Runner',
    'src/main.mjs#run',
    'src/main.mjs#arrow',
    'src/main.mjs#lazy'
  ]) {
    assert.ok(
      graph.nodes.some(node => node.key === key),
      key
    );
  }

  const dep = graph.nodes.find(node =>
    node.kind === 'file' &&
    node.path === 'src/dep.mjs'
  );
  const lazy = graph.nodes.find(node =>
    node.kind === 'file' &&
    node.path === 'src/lazy.mjs'
  );
  assert.ok(dep);
  assert.ok(lazy);

  assert.ok(graph.edges.some(edge =>
    edge.from === main.id &&
    edge.to === dep.id &&
    edge.type === 'IMPORTS'
  ));
  assert.ok(graph.edges.some(edge =>
    edge.from === main.id &&
    edge.to === dep.id &&
    edge.type === 'REEXPORTS'
  ));
  assert.ok(graph.edges.some(edge =>
    edge.from === main.id &&
    edge.to === lazy.id &&
    edge.type === 'DYNAMIC_IMPORTS'
  ));

  for (const moduleName of [
    'node:path',
    'node:fs'
  ]) {
    const moduleNode = graph.nodes.find(node =>
      node.kind === 'module' &&
      node.key === moduleName
    );
    assert.ok(moduleNode);
    assert.equal(moduleNode.external, true);
    assert.equal(moduleNode.unresolved, true);

    assert.ok(
      graph.meta.unresolvedReferences?.some(item =>
        item.provider_id === 'builtin-javascript' &&
        item.target === moduleName &&
        item.resolution === 'UNRESOLVED'
      )
    );
  }

  const evidence = graph.meta.evidence?.find(record =>
    record.provider_id === 'builtin-javascript' &&
    record.provenance.path === 'src/main.mjs'
  );
  assert.ok(evidence);
  assert.equal(evidence.kind, 'STATIC_ANALYSIS');
  assert.equal(
    evidence.trust_class,
    'REPOSITORY_UNTRUSTED'
  );

  assert.equal(
    graph.nodes.some(node =>
      node.key?.includes('shouldNotAppear')
    ),
    false
  );
});

test('JavaScript lexical analyzer masks comments in template expressions and raw template text', async t => {
  const root = await tempDir(
    t,
    'kneekura-js-comments-'
  );

  const source = path.join(root, 'entry.mjs');
  const dependency = path.join(root, 'real.mjs');
  await fs.writeFile(
    dependency,
    'export const real = true;\n',
    'utf8'
  );
  await fs.writeFile(
    source,
    [
      "const url = 'https://example.invalid/path';",
      "const quoted = \"import './quoted-fake.mjs'; export function quotedFake() {}\";",
      "const singleQuoted = 'require(\\\"./single-fake.mjs\\\"); export class singleFake {}';",
      "// import 'fake-module';",
      '/* export function fakeBlock() {} */',
      "const raw = `import 'raw-fake'; export function rawFake() {}`;",
      "const expression = `value: ${ /* import 'expr-fake'; export function exprFake() {} */ import('./real.mjs') }`;"
      "const nested = `outer ${ `inner ${ /* export function nestedFake() {} */ 1 }` }`;",
      'export function realFunction() {',
      '  return url;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  const graph = await scanRepository(root);

  assert.ok(graph.nodes.some(node =>
    node.kind === 'function' &&
    node.key === 'entry.mjs#realFunction'
  ));
  for (const fake of [
    'entry.mjs#fakeBlock',
    'entry.mjs#rawFake',
    'entry.mjs#exprFake',
    'entry.mjs#nestedFake',
    'entry.mjs#quotedFake',
    'entry.mjs#singleFake',
    'fake-module',
    'raw-fake',
    'expr-fake',
    './quoted-fake.mjs',
    './single-fake.mjs'
  ]) {
    assert.equal(
      graph.nodes.some(node => node.key === fake),
      false,
      fake
    );
  }

  const entry = graph.nodes.find(node =>
    node.kind === 'file' &&
    node.path === 'entry.mjs'
  );
  const real = graph.nodes.find(node =>
    node.kind === 'file' &&
    node.path === 'real.mjs'
  );
  assert.ok(entry);
  assert.ok(real);
  assert.ok(graph.edges.some(edge =>
    edge.from === entry.id &&
    edge.to === real.id &&
    edge.type === 'DYNAMIC_IMPORTS'
  ));
});

test('JavaScript module type is classified only when the extension is authoritative', async t => {
  const root = await tempDir(
    t,
    'kneekura-js-module-type-'
  );

  await fs.writeFile(
    path.join(root, 'module.mjs'),
    'export const esm = true;\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'legacy.cjs'),
    'exports.legacy = true;\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'ambiguous.js'),
    'export const maybe = true;\n',
    'utf8'
  );

  const graph = await scanRepository(root);
  const byPath = pathName =>
    graph.nodes.find(node =>
      node.kind === 'file' &&
      node.path === pathName
    );

  assert.equal(
    byPath('module.mjs').moduleType,
    'esm'
  );
  assert.equal(
    byPath('legacy.cjs').moduleType,
    'commonjs'
  );
  assert.equal(
    Object.hasOwn(
      byPath('ambiguous.js'),
      'moduleType'
    ),
    false
  );
});

test('COMMIT snapshot analysis materializes JavaScript source from the pinned Git tree instead of dirty workspace bytes', async t => {
  const root = await tempDir(
    t,
    'kneekura-js-commit-repo-'
  );
  const tempParent = await tempDir(
    t,
    'kneekura-js-commit-temp-'
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

  const source = path.join(root, 'self.mjs');
  await fs.writeFile(
    source,
    [
      'export function committedBoundary() {',
      '  return true;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  await git(root, ['add', 'self.mjs']);
  await git(root, ['commit', '-m', 'committed js']);

  const commit = await git(
    root,
    ['rev-parse', 'HEAD']
  );

  const dirty = [
    'export function dirtyBoundary() {',
    '  return false;',
    '}',
    ''
  ].join('\n');
  await fs.writeFile(source, dirty, 'utf8');

  const execution = await analyzeInternal(
    {
      schema: 'core.analysis-request/v1',
      repository: root,
      snapshot_selector: {
        kind: 'COMMIT',
        commit
      },
      mode: 'DIAGNOSE',
      question:
        'Inspect the pinned JavaScript boundary.',
      scope: {
        paths: ['self.mjs']
      },
      policy: 'precision',
      output_profile: 'compact'
    },
    {
      commitMaterialization: {
        tempParent
      }
    }
  );

  assert.equal(
    execution.result.snapshot.kind,
    'COMMIT'
  );
  assert.equal(
    execution.result.snapshot.base_commit,
    commit
  );

  assert.ok(
    execution.state.graph.nodes.some(node =>
      node.kind === 'function' &&
      node.key === 'self.mjs#committedBoundary'
    )
  );
  assert.equal(
    execution.state.graph.nodes.some(node =>
      node.key === 'self.mjs#dirtyBoundary'
    ),
    false
  );

  assert.ok(
    execution.result.evidence.some(record =>
      record.provider_id === 'builtin-javascript' &&
      record.provenance.path === 'self.mjs'
    )
  );

  assert.equal(
    await fs.readFile(source, 'utf8'),
    dirty
  );
  assert.deepEqual(
    await fs.readdir(tempParent),
    []
  );
});
