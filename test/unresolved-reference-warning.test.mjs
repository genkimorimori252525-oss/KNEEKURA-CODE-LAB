import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeInternal
} from '../src/core/api/analyze.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);
const FIXTURE = path.join(
  ROOT,
  'fixtures',
  'forge-mini'
);
const TRACE = path.join(
  ROOT,
  'fixtures',
  'runtime',
  'kneekura-trace.jsonl'
);

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

function request(root, question) {
  return {
    schema: 'core.analysis-request/v1',
    repository: root,
    mode: 'DIAGNOSE',
    question,
    policy: 'precision',
    output_profile: 'compact'
  };
}

function unresolvedWarnings(result) {
  return (result.warnings ?? [])
    .filter(item =>
      item.code === 'UNRESOLVED_REFERENCE'
    );
}

test('external JavaScript modules stay explicit in graph Evidence without becoming analysis warnings', async t => {
  const root = await tempDir(
    t,
    'kneekura-warning-js-'
  );

  await fs.writeFile(
    path.join(root, 'entry.mjs'),
    [
      "import path from 'node:path';",
      "import pkg from 'some-package';",
      "import './missing.mjs';",
      'export function run() {',
      '  return [path.sep, pkg];',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  const execution = await analyzeInternal(
    request(
      root,
      'Inspect unresolved JavaScript references.'
    )
  );

  const refs =
    execution.state.graph.meta
      .unresolvedReferences
      .filter(item =>
        item.provider_id ===
          'builtin-javascript'
      );

  assert.deepEqual(
    refs.map(item => item.target).sort(),
    [
      './missing.mjs',
      'node:path',
      'some-package'
    ]
  );

  assert.deepEqual(
    unresolvedWarnings(execution.result)
      .map(item => item.ref.target),
    ['./missing.mjs']
  );
});

test('Java classpath imports stay explicit but only repository-local unresolved imports become warnings', async t => {
  const root = await tempDir(
    t,
    'kneekura-warning-java-'
  );
  const src = path.join(root, 'src');
  await fs.mkdir(src, { recursive: true });

  await fs.writeFile(
    path.join(src, 'A.java'),
    [
      'package demo;',
      'import java.util.List;',
      'import net.minecraftforge.eventbus.api.SubscribeEvent;',
      'import demo.B;',
      'public class A {',
      '  private List<String> values;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  await fs.writeFile(
    path.join(src, 'B.java'),
    [
      'package demo;',
      'public class B {}',
      ''
    ].join('\n'),
    'utf8'
  );

  const execution = await analyzeInternal(
    request(
      root,
      'Inspect unresolved Java imports.'
    )
  );

  const refs =
    execution.state.graph.meta
      .unresolvedReferences
      .filter(item =>
        item.provider_id === 'builtin-java'
      );

  assert.deepEqual(
    refs.map(item => item.target).sort(),
    [
      'demo.B',
      'java.util.List',
      'net.minecraftforge.eventbus.api.SubscribeEvent'
    ]
  );

  assert.deepEqual(
    unresolvedWarnings(execution.result)
      .map(item => item.ref.target),
    ['demo.B']
  );
});

test('runtime unresolved static matches remain analysis warnings', async t => {
  const dir = await tempDir(
    t,
    'kneekura-warning-runtime-'
  );
  const network = path.join(
    dir,
    'unknown-channel.net.jsonl'
  );

  await fs.writeFile(
    network,
    [
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
    ].join('\n') + '\n',
    'utf8'
  );

  const base = request(
    FIXTURE,
    'Inspect runtime network references.'
  );
  base.runtime_artifacts = [
    {
      kind: 'trace',
      path: TRACE
    },
    {
      kind: 'network',
      path: network
    }
  ];

  const execution =
    await analyzeInternal(base);

  assert.equal(
    unresolvedWarnings(execution.result)
      .some(item =>
        item.ref?.provider_id ===
          'network-companion-adapter' &&
        item.ref?.kind ===
          'STATIC_NETWORK_CHANNEL' &&
        item.ref?.target ===
          'missing:channel'
      ),
    true
  );
});
