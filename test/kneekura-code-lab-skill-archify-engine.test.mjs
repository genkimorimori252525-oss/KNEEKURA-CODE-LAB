import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSkillRunRoot,
  removeSkillRunRoot,
  runStableArchifyEngine,
  validateEngineRunReceipt
} from '../src/skill/index.mjs';

const PINNED_SHA = '4c59fa6557a2385beaaef8c7219cc414573acc9f0c30a932d5053b0b20689a46';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-archify-test-'));
  const archifyRoot = path.join(parent, 'archify');
  const targetRoot = path.join(parent, 'target');
  await fs.mkdir(path.join(archifyRoot, 'bin'), { recursive: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(archifyRoot, 'package.json'), JSON.stringify({ name: 'archify', version: '2.16.0' }));
  await fs.writeFile(path.join(archifyRoot, 'bin', 'archify.mjs'), '// fixture');
  await fs.writeFile(path.join(targetRoot, 'README.md'), '# target\n');
  const run = await createSkillRunRoot({ parent, runId: 'archify-test' });
  return { parent, archifyRoot, targetRoot, run };
}

function typedIr(url, revision) {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: 'Fixture architecture',
      repository: { url, revision }
    },
    components: [{
      id: 'core',
      type: 'backend',
      label: 'Core',
      sources: [{ path: 'README.md', line: 1 }],
      pos: [80, 80],
      size: [140, 60]
    }]
  };
}

function fakeExecutor() {
  return async ({ args }) => {
    const command = args[0];
    if (command === 'doctor') {
      return { status: 0, stdout: 'Archify doctor\n[ok] fixture\n\nArchify is ready.\n', stderr: '' };
    }
    if (command === 'validate') {
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: 'validate',
          type: 'architecture',
          checks: [{ name: 'single_svg', ok: true }],
          composition: { status: 'pass', summary: { errors: 0, warnings: 0 } }
        }),
        stderr: ''
      };
    }
    if (command === 'deliver') {
      const input = args[2];
      const output = args[3];
      const spec = await fs.readFile(input);
      const artifact = Buffer.from('<!doctype html><html><body>archify fixture</body></html>');
      await fs.writeFile(output, artifact);
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: 'deliver',
          type: 'architecture',
          input,
          output,
          specification: { sha256: sha256(spec), bytes: spec.length },
          artifact: { sha256: sha256(artifact), bytes: artifact.length },
          validation: {
            checksPassed: 1,
            checkCount: 1,
            compositionProfile: 'showcase',
            compositionStatus: 'pass',
            errors: 0,
            warnings: 0
          },
          evidence: {
            verified: true,
            repository: 'https://github.com/example/target',
            revision: 'a'.repeat(40),
            references: 1
          }
        }),
        stderr: ''
      };
    }
    if (command === 'visual-check') {
      const artifact = await fs.readFile(args[1]);
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: 'visual-check',
          status: 'pass',
          visualReview: 'pending',
          artifact: { path: args[1], sha256: sha256(artifact), bytes: artifact.length },
          containment: { status: 'pass' },
          captures: { status: 'pass' },
          sidecars: { receipt: 'artifact.visual-check.json', contactSheet: 'artifact.visual-check.html' }
        }),
        stderr: ''
      };
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

test('stable Archify engine rejects a typed IR bound to a different target revision', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => runStableArchifyEngine({
        archifyRoot: f.archifyRoot,
        archifyArtifactSha256: PINNED_SHA,
        targetRoot: f.targetRoot,
        targetSnapshotId: 'snapshot:test',
        targetRepositoryUrl: 'https://github.com/example/target',
        targetRevision: 'a'.repeat(40),
        typedIrAuthor: async () => typedIr('https://github.com/example/target', 'b'.repeat(40)),
        runRoot: f.run.root,
        attemptId: 'attempt-archify-mismatch',
        scopeDigest: 'sha256:' + 'c'.repeat(64),
        execute: fakeExecutor()
      }),
      error => error?.code === 'ARCHIFY_TARGET_BINDING_MISMATCH'
    );
  } finally {
    await removeSkillRunRoot(f.run.root, { expectedRunId: 'archify-test', protectedRoots: [] });
    await fs.rm(f.parent, { recursive: true, force: true });
  }
});

test('stable Archify engine separates upstream delivery, automated visual evidence and perceptual review', async () => {
  const f = await fixture();
  try {
    const result = await runStableArchifyEngine({
      archifyRoot: f.archifyRoot,
      archifyArtifactSha256: PINNED_SHA,
      targetRoot: f.targetRoot,
      targetSnapshotId: 'snapshot:test',
      targetRepositoryUrl: 'https://github.com/example/target',
      targetRevision: 'a'.repeat(40),
      typedIrAuthor: async () => typedIr('https://github.com/example/target', 'a'.repeat(40)),
      runRoot: f.run.root,
      attemptId: 'attempt-archify-001',
      scopeDigest: 'sha256:' + 'c'.repeat(64),
      perceptualReview: { status: 'SKIPPED', reason: 'unit test does not claim human visual review' },
      execute: fakeExecutor()
    });

    assert.equal(result.schema, 'kneekura.code-lab.archify-engine-result/v1');
    assert.equal(result.receipt.engineId, 'archify');
    assert.equal(result.receipt.implementationOrigin, 'pinned-upstream');
    assert.equal(result.receipt.orchestrationMode, 'native');
    assert.equal(result.receipt.claimLevel, 'NATIVE');
    assert.equal(result.receipt.status, 'SUCCESS');
    assert.equal(result.receipt.acceptance.doctor.status, 'PASSED');
    assert.equal(result.receipt.acceptance.validation.status, 'PASSED');
    assert.equal(result.receipt.acceptance.delivery.status, 'PASSED');
    assert.equal(result.receipt.acceptance.browser_visual_check.status, 'PASS');
    assert.equal(result.receipt.acceptance.browser_visual_check.visual_review, 'pending');
    assert.equal(result.receipt.acceptance.perceptual_review.status, 'SKIPPED');
    assert.equal(result.receipt.acceptance.perceptual_review.artifact_sha256, null);
    assert(result.artifact.bytes.length > 0);
    assert(result.deliveryZip.length > 0);
    assert(result.deliveryZipDigest.startsWith('sha256:'));
    assert.equal(validateEngineRunReceipt(result.receipt), true);
  } finally {
    await removeSkillRunRoot(f.run.root, { expectedRunId: 'archify-test', protectedRoots: [] });
    await fs.rm(f.parent, { recursive: true, force: true });
  }
});