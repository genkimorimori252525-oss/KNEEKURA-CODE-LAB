import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanRepository } from '../src/core/scan.mjs';

test('JavaScript lexical provider preserves Evidence for a successful zero-delta source scan', async t => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-js-empty-evidence-')
  );
  t.after(() =>
    fs.rm(root, { recursive: true, force: true })
  );

  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, 'src', 'a-consumer.mjs'),
    [
      "import { SCHEMA } from './z-schema.mjs';",
      'export function readSchema() { return SCHEMA; }',
      ''
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'src', 'z-schema.mjs'),
    "export const SCHEMA = 'fixture/v1';\n",
    'utf8'
  );

  const graph = await scanRepository(root);
  const evidence = graph.meta.evidence?.find(record =>
    record.provider_id === 'builtin-javascript' &&
    record.provenance.path === 'src/z-schema.mjs'
  );

  assert.ok(evidence);
  assert.equal(evidence.kind, 'STATIC_ANALYSIS');
  assert.deepEqual(
    evidence.observation.graph_delta,
    {
      nodes_added: 0,
      edges_added: 0,
      node_kinds: {},
      edge_types: {}
    }
  );

  const providerResult = graph.meta.providerResults?.find(result =>
    result.provider_id === 'builtin-javascript' &&
    result.unit_ref === 'src/z-schema.mjs'
  );
  assert.ok(providerResult);
  assert.equal(providerResult.metrics.nodes_added, 0);
  assert.equal(providerResult.metrics.edges_added, 0);
  assert.equal(providerResult.metrics.evidence_count, 1);
  assert.equal(providerResult.evidence_ids.length, 1);
});