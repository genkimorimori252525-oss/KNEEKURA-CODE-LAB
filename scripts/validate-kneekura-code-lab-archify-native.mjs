import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createSkillRunRoot,
  removeSkillRunRoot,
  runStableArchifyEngine,
  validateEngineRunReceipt
} from '../src/skill/index.mjs';

const execFile = promisify(childProcess.execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARCHIFY_ROOT = process.env.KNEEKURA_ARCHIFY_ROOT;
const ARCHIFY_SHA256 = process.env.KNEEKURA_ARCHIFY_ARTIFACT_SHA256;
if (!ARCHIFY_ROOT || !ARCHIFY_SHA256) throw new Error('PINNED_ARCHIFY_ENV_REQUIRED');

const revision = String(process.env.GITHUB_SHA || (await execFile('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout).trim();
assert.match(revision, /^[0-9a-f]{40}$/i);
const run = await createSkillRunRoot({ parent: os.tmpdir(), runId: 'archify-native-ci' });
try {
  const result = await runStableArchifyEngine({
    archifyRoot: ARCHIFY_ROOT,
    archifyArtifactSha256: ARCHIFY_SHA256,
    targetRoot: ROOT,
    targetSnapshotId: `commit:${revision}`,
    targetRepositoryUrl: 'https://github.com/genkimorimori252525-oss/KNEEKURA-CODE-LAB',
    targetRevision: revision,
    typedIrAuthor: async () => ({
      schema_version: 1,
      diagram_type: 'architecture',
      meta: {
        title: 'KNEEKURA Code LAB Skill — native engine map',
        subtitle: 'Router → hardened runtime → three isolated engines → delivery',
        locale: 'ja',
        visual_preset: 'signal-flow',
        quality_profile: 'showcase',
        repository: {
          url: 'https://github.com/genkimorimori252525-oss/KNEEKURA-CODE-LAB',
          revision
        },
        views: [
          { id: 'request-path', label: 'Request path', focus: ['skill','router','runtime','kneekura','archify','delivery'], note: 'Follow one selected engine without substitution.' },
          { id: 'truth-boundary', label: 'Truth boundary', focus: ['snapshot','runtime','kneekura','ua','archify'], note: 'Three views share identity but never promote consensus into canonical truth.' }
        ]
      },
      components: [
        { id: 'skill', type: 'frontend', label: 'Umbrella Skill', sublabel: 'one public entry', pos: [40,300], size: [145,64], sources: [{ path: 'skills/kneekura-code-lab/SKILL.md', line: 1 }] },
        { id: 'router', type: 'backend', label: '3-way Router', sublabel: 'no hidden default', pos: [245,300], size: [145,64], sources: [{ path: 'src/skill/router.mjs', line: 1 }] },
        { id: 'snapshot', type: 'security', label: 'Target Snapshot', sublabel: 'exact identity', pos: [245,110], size: [145,64], sources: [{ path: 'src/core/identity/snapshot.mjs', line: 1 }] },
        { id: 'runtime', type: 'security', label: 'Host Runtime', sublabel: 'budget + receipts', pos: [450,300], size: [145,64], sources: [{ path: 'src/skill/runtime.mjs', line: 1 }] },
        { id: 'kneekura', type: 'backend', label: 'KNEEKURA', sublabel: 'Human Explorer v2', pos: [655,180], size: [150,64], sources: [{ path: 'src/skill/engines/kneekura.mjs', line: 1 }] },
        { id: 'ua', type: 'backend', label: 'Understand Anything', sublabel: 'pinned upstream', pos: [655,300], size: [150,64], sources: [{ path: 'engine-lock.json', line: 1 }] },
        { id: 'archify', type: 'backend', label: 'Archify', sublabel: 'pinned upstream', pos: [655,420], size: [150,64], sources: [{ path: 'src/skill/engines/archify.mjs', line: 1 }] },
        { id: 'delivery', type: 'database', label: 'Artifact Delivery', sublabel: 'sanitized ZIP', pos: [875,300], size: [150,64], sources: [{ path: 'src/human-analysis/zip.mjs', line: 1 }] }
      ],
      boundaries: [
        { kind: 'region', label: 'KNEEKURA Code LAB control plane', wraps: ['skill','router','snapshot','runtime'] },
        { kind: 'security-group', label: 'Engine isolation', wraps: ['kneekura','ua','archify'] }
      ],
      connections: [
        { id: 'skill-router', from: 'skill', to: 'router', variant: 'emphasis' },
        { id: 'snapshot-router', from: 'snapshot', to: 'router', label: 'identity', variant: 'security', fromSide: 'bottom', toSide: 'top' },
        { id: 'router-runtime', from: 'router', to: 'runtime', variant: 'emphasis' },
        { id: 'runtime-kneekura', from: 'runtime', to: 'kneekura', label: 'selected', variant: 'emphasis' },
        { id: 'runtime-ua', from: 'runtime', to: 'ua', label: 'selected', variant: 'dashed' },
        { id: 'runtime-archify', from: 'runtime', to: 'archify', label: 'selected', variant: 'emphasis' },
        { id: 'kneekura-delivery', from: 'kneekura', to: 'delivery' },
        { id: 'ua-delivery', from: 'ua', to: 'delivery', variant: 'dashed' },
        { id: 'archify-delivery', from: 'archify', to: 'delivery' }
      ],
      cards: [
        { dot: 'cyan', title: 'Selection', items: ['Explicit engine choice', 'No substitution under another engine label'] },
        { dot: 'rose', title: 'Truth', items: ['Same Target Snapshot identity', 'Engine agreement is not canonical evidence'] },
        { dot: 'emerald', title: 'Delivery', items: ['Upstream receipt gates', 'Sanitized artifact-only ZIP'] }
      ]
    }),
    runRoot: run.root,
    attemptId: 'attempt-archify-native-ci',
    scopeDigest: `sha256:${revision.padEnd(64, '0').slice(0,64)}`,
    perceptualReview: {
      status: 'SKIPPED',
      reason: 'CI collects upstream automated visual evidence; perceptual review remains a separate human/image-reader gate.'
    }
  });
  assert.equal(result.receipt.acceptance.doctor.status, 'PASSED');
  assert.equal(result.receipt.acceptance.validation.status, 'PASSED');
  assert.equal(result.receipt.acceptance.delivery.status, 'PASSED');
  assert.equal(result.receipt.acceptance.browser_visual_check.status, 'PASS');
  assert.equal(result.receipt.acceptance.perceptual_review.status, 'SKIPPED');
  assert.equal(result.receipt.acceptance.delivery.artifact_sha256, result.artifact.sha256);
  assert.equal(validateEngineRunReceipt(result.receipt), true);
  process.stdout.write(JSON.stringify({
    schema: 'kneekura.archify-native-ci/v1',
    revision,
    status: result.receipt.status,
    archify_version: result.receipt.implementationVersion,
    artifact_sha256: result.artifact.sha256,
    delivery_zip_digest: result.deliveryZipDigest,
    validation: result.receipt.acceptance.validation,
    visual_check: result.receipt.acceptance.browser_visual_check,
    perceptual_review: result.receipt.acceptance.perceptual_review
  }, null, 2) + '\n');
} finally {
  await removeSkillRunRoot(run.root, { expectedRunId: 'archify-native-ci' });
}