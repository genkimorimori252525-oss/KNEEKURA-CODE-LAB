import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditCorePresentationBoundary
} from '../scripts/check-presentation-boundary.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

test('P0 CORE has no Presentation or UI imports', async () => {
  const violations = await auditCorePresentationBoundary({
    root: ROOT
  });
  assert.deepEqual(violations, []);
});

test('P0 boundary guard rejects package and local Presentation imports', async t => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-presentation-boundary-')
  );
  t.after(() =>
    fs.rm(root, { recursive: true, force: true })
  );

  const core = path.join(root, 'src', 'core');
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(
    path.join(core, 'bad.mjs'),
    [
      "import React from 'react';",
      "import { ReactFlow } from '@xyflow/react';",
      "import ELK from 'elkjs/lib/elk.bundled.js';",
      "import dagre from '@dagrejs/dagre';",
      "import { forceSimulation } from 'd3-force';",
      "import archify from 'archify';",
      "import '../viewer/model.mjs';",
      "export { x } from '../../third_party/example/x.mjs';"
    ].join('\n') + '\n',
    'utf8'
  );

  const violations = await auditCorePresentationBoundary({
    root
  });
  const specifiers = new Set(
    violations.map(item => item.specifier)
  );

  for (const forbidden of [
    'react',
    '@xyflow/react',
    'elkjs/lib/elk.bundled.js',
    '@dagrejs/dagre',
    'd3-force',
    'archify',
    '../viewer/model.mjs',
    '../../third_party/example/x.mjs'
  ]) {
    assert.equal(
      specifiers.has(forbidden),
      true,
      'expected boundary violation for ' + forbidden
    );
  }
});
