import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as relay from '../src/github-relay/index.mjs';
import { createEngineRunReceipt } from '../src/skill/contracts.mjs';

const REVISION = 'a'.repeat(40);
const SNAPSHOT = `snapshot:sha256:${'b'.repeat(64)}`;
const SCOPE = `sha256:${'c'.repeat(64)}`;
const RUNTIME = 'd'.repeat(40);
const LOCK = `sha256:${'e'.repeat(64)}`;
const PARENT_RUN = 'ghr-220-parent';
const PARENT_ISSUE = 220;
const ZIP_KIND = {
  kneekura: 'KNEEKURA_HUMAN_EXPLORER_ZIP',
  'understand-anything': 'UA_SKILL_ZIP',
  archify: 'ARCHIFY_SKILL_ZIP'
};

const parentRequest = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-request/v1',
  selection: 'all',
  target: { repository: 'owner/repository', revision: REVISION },
  commonScope: { question: 'explain exact snapshot independently' },
  engineOptions: {},
  minimumClaimLevel: {},
  semanticContextMode: 'per-engine'
});
const parentPlan = Object.freeze({
  schema: 'kneekura.code-lab.github-relay-plan/v1',
  run_id: PARENT_RUN,
  selection: 'all',
  target: {
    repository: 'owner/repository',
    revision: REVISION,
    snapshot_id: SNAPSHOT,
    scope_digest: SCOPE
  },
  semantic_context_mode: 'per-engine',
  code_lab_revision: RUNTIME,
  engine_lock_digest: LOCK
});

function fixtures() {
  return relay.createAllChildBindings({
    parentRunId: PARENT_RUN,
    parentIssueNumber: PARENT_ISSUE,
    request: parentRequest,
    relayPlan: parentPlan
  }).map((slot, index) => {
    const binding = { ...slot, child_issue_number: 301 + index };
    const contextClaim = relay.validateAllContextClaim({
      schema: relay.ALL_CONTEXT_CLAIM_SCHEMA,
      parent_run_id: PARENT_RUN,
      parent_issue_number: PARENT_ISSUE,
      child_issue_number: binding.child_issue_number,
      engine_id: binding.engine_id,
      host_context_id: `host-${binding.engine_id}-${index + 1}`,
      assurance_class: relay.ALL_CONTEXT_ASSURANCE_CLASS
    }, binding);
    const sealedBytes = Buffer.from(`sealed-${binding.engine_id}-bytes`);
    const receipt = createEngineRunReceipt({
      engineId: binding.engine_id,
      implementationOrigin: binding.engine_id === 'kneekura' ? 'first-party' : 'pinned-upstream',
      implementationVersion: 'test',
      orchestrationMode: 'native',
      snapshotId: SNAPSHOT,
      scopeDigest: SCOPE,
      attemptId: `attempt-${binding.engine_id}`,
      status: 'SUCCESS',
      claimLevel: 'NATIVE',
      claimSatisfied: true,
      acceptance: { passed: true },
      coverage: { fixture: true },
      artifacts: [{
        kind: ZIP_KIND[binding.engine_id],
        digest: `sha256:${crypto.createHash('sha256').update(sealedBytes).digest('hex')}`,
        bytes: sealedBytes.length
      }],
      warnings: [],
      errors: []
    });
    const relayResult = {
      schema: 'kneekura.code-lab.github-relay-result/v1',
      run_id: relay.createRelayRunId(binding.child_issue_number, REVISION, SCOPE),
      status: 'SUCCESS',
      target: { ...parentPlan.target },
      code_lab_revision: RUNTIME,
      engine_lock_digest: LOCK,
      terminal: { status: 'SUCCESS' },
      artifacts: [],
      artifact_bytes_exposed: false
    };
    return { binding, contextClaim, receipt, relayResult, sealedBytes };
  });
}

test('production Relay runner consumes parent-bound child control records and stages child result artifacts', async () => {
  const source = await fs.readFile(path.resolve('scripts/run-kneekura-github-relay.mjs'), 'utf8');
  assert.match(source, /stageChildResultArtifact/);
  assert.match(source, /thread\.allChildBindings/);
  assert.match(source, /thread\.contextClaims/);
  assert.match(source, /allChildBinding/);
  assert.match(source, /allContextClaim/);
});

test('parent compose CLI re-reads exact three staged child artifacts and writes sealed ALL bundle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-all-compose-cli-'));
  try {
    const children = fixtures();
    const rows = [];
    for (const child of children) {
      const staged = await relay.stageChildResultArtifact({
        outputRoot: root,
        binding: child.binding,
        contextClaim: child.contextClaim,
        relayResult: child.relayResult,
        receipt: child.receipt,
        sealedBytes: child.sealedBytes
      });
      rows.push({
        binding: child.binding,
        context_claim: child.contextClaim,
        artifact_root: staged.artifact_root
      });
    }
    const inputPath = path.join(root, 'compose-input.json');
    const outputPath = path.join(root, 'all-result.zip');
    await fs.writeFile(inputPath, JSON.stringify({
      schema: 'kneekura.code-lab.github-relay-all-compose-input/v1',
      parent_plan: parentPlan,
      children: rows
    }, null, 2));

    const result = childProcess.spawnSync(
      process.execPath,
      [path.resolve('scripts/compose-kneekura-github-relay-all.mjs')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          KNEEKURA_RELAY_ALL_COMPOSE_INPUT: inputPath,
          KNEEKURA_RELAY_ALL_COMPOSE_OUTPUT: outputPath
        }
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const bundle = await fs.readFile(outputPath);
    assert.ok(bundle.length > 100);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.schema, 'kneekura.code-lab.github-relay-all-compose-result/v1');
    assert.equal(summary.run_id, PARENT_RUN);
    assert.match(summary.bundle_digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});