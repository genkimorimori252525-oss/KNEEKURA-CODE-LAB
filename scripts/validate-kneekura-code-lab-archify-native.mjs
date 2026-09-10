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

const revision = String(
  process.env.GITHUB_SHA ||
  (await execFile('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout
).trim();
assert.match(revision, /^[0-9a-f]{40}$/i);

const run = await createSkillRunRoot({
  parent: os.tmpdir(),
  runId: 'archify-native-ci'
});

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
        title: 'KNEEKURA Code LAB Skill native path',
        locale: 'en',
        quality_profile: 'showcase',
        repository: {
          url: 'https://github.com/genkimorimori252525-oss/KNEEKURA-CODE-LAB',
          revision
        },
        views: [
          {
            id: 'native-path',
            label: 'Native Archify path',
            focus: ['skill', 'router', 'runtime', 'archify', 'delivery'],
            note: 'Follow one explicitly selected engine from the umbrella Skill to sanitized delivery.'
          },
          {
            id: 'snapshot-binding',
            label: 'Snapshot binding',
            focus: ['snapshot', 'router', 'archify'],
            note: 'The upstream diagram stays bound to the same exact target revision.'
          }
        ]
      },
      layout: {
        mode: 'grid',
        origin: [40, 120],
        cols: 5,
        gapX: 50,
        gapY: 90,
        cellW: 155,
        cellH: 72
      },
      components: [
        {
          id: 'skill',
          type: 'frontend',
          label: 'Umbrella Skill',
          sublabel: 'public entry',
          row: 0,
          col: 0,
          sources: [{ path: 'skills/kneekura-code-lab/SKILL.md', line: 1 }]
        },
        {
          id: 'router',
          type: 'backend',
          label: 'Engine Router',
          sublabel: 'explicit selection',
          row: 0,
          col: 1,
          sources: [{ path: 'src/skill/router.mjs', line: 1 }]
        },
        {
          id: 'runtime',
          type: 'security',
          label: 'Host Runtime',
          sublabel: 'budgets + receipts',
          row: 0,
          col: 2,
          sources: [{ path: 'src/skill/runtime.mjs', line: 1 }]
        },
        {
          id: 'archify',
          type: 'backend',
          label: 'Archify v2.16.0',
          sublabel: 'pinned upstream',
          row: 0,
          col: 3,
          sources: [{ path: 'src/skill/engines/archify.mjs', line: 1 }]
        },
        {
          id: 'delivery',
          type: 'database',
          label: 'Artifact Delivery',
          sublabel: 'sanitized ZIP',
          row: 0,
          col: 4,
          sources: [{ path: 'src/human-analysis/zip.mjs', line: 1 }]
        },
        {
          id: 'snapshot',
          type: 'security',
          label: 'Target Snapshot',
          sublabel: 'exact identity',
          row: 1,
          col: 1,
          sources: [{ path: 'src/core/identity/snapshot.mjs', line: 1 }]
        }
      ],
      connections: [
        { id: 'skill-router', from: 'skill', to: 'router', variant: 'emphasis' },
        { id: 'router-runtime', from: 'router', to: 'runtime', variant: 'emphasis' },
        { id: 'runtime-archify', from: 'runtime', to: 'archify', variant: 'emphasis' },
        { id: 'archify-delivery', from: 'archify', to: 'delivery', variant: 'emphasis' },
        {
          id: 'snapshot-router',
          from: 'snapshot',
          to: 'router',
          label: 'exact revision',
          variant: 'security',
          fromSide: 'top',
          toSide: 'bottom'
        }
      ],
      cards: [
        {
          dot: 'cyan',
          title: 'Selection',
          items: ['Explicit engine choice', 'No hidden substitution']
        },
        {
          dot: 'rose',
          title: 'Truth',
          items: ['Exact Target Snapshot binding', 'Upstream output never becomes canonical truth by consensus']
        },
        {
          dot: 'emerald',
          title: 'Delivery',
          items: ['Native validate and deliver receipts', 'Automated visual evidence remains separate from perceptual review']
        }
      ]
    }),
    runRoot: run.root,
    attemptId: 'attempt-archify-native-ci',
    scopeDigest: `sha256:${revision.padEnd(64, '0').slice(0, 64)}`,
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
  assert.equal(
    result.receipt.acceptance.delivery.artifact_sha256,
    result.artifact.sha256
  );
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
  await removeSkillRunRoot(run.root, {
    expectedRunId: 'archify-native-ci'
  });
}