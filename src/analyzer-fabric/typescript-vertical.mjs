import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepositoryIdentity } from '../core/identity/repository.mjs';
import { createCommitSnapshot } from '../core/identity/snapshot.mjs';
import { profileRepository, buildCapabilityCoverage } from './profile.mjs';
import { fuseAnalyzerObservations } from './fusion.mjs';
import { runFabricProvider } from './providers/common.mjs';
import { createTypeScriptCompilerProvider } from './providers/typescript-compiler.mjs';
import { buildCoreEvidenceLedgerFromFabric } from './core-evidence.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

async function sourceTextMap(rootDirectory, files) {
  const map = {};
  for (const file of files) {
    if (file.primary_language !== 'TYPESCRIPT') continue;
    map[file.path] = await fs.readFile(path.join(rootDirectory, file.path), 'utf8');
  }
  return map;
}

function executionReceipts(profile, provider, executionStatus, executionReason = null) {
  const capabilities = new Set(provider.manifest.capabilities);
  const receipts = [];
  for (const file of profile.files) {
    if (file.primary_language !== 'TYPESCRIPT') continue;
    for (const capability of capabilities) {
      receipts.push({
        provider_id: provider.manifest.id,
        path: file.path,
        capability,
        execution_status: executionStatus,
        ...(executionReason ? { execution_reason: executionReason } : {})
      });
    }
  }
  return receipts;
}

export async function runTypeScriptSemanticVertical({
  rootDirectory,
  commitSha,
  typescript,
  tsconfigPath = 'tsconfig.json',
  expectedTypeScriptVersion = null,
  requireClean = true
} = {}) {
  const root = path.resolve(String(rootDirectory ?? ''));
  if (!rootDirectory) throw new TypeError('rootDirectory is required');
  const requestedCommit = String(commitSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(requestedCommit)) throw new TypeError('commitSha must be a full git object id');
  const head = (await git(root, ['rev-parse','HEAD'])).toLowerCase();
  if (head !== requestedCommit) throw new Error(`ANALYZER_SNAPSHOT_MISMATCH: HEAD ${head} != requested ${requestedCommit}`);
  if (requireClean) {
    const status = await git(root, ['status','--porcelain=v1','--untracked-files=all']);
    if (status) throw new Error('ANALYZER_SNAPSHOT_DIRTY: TypeScript semantic vertical requires a clean worktree');
  }

  const repository = await resolveRepositoryIdentity(root);
  const snapshot = createCommitSnapshot(repository, requestedCommit);
  const provider = createTypeScriptCompilerProvider({
    typescript,
    expectedTypeScriptVersion: expectedTypeScriptVersion ?? String(typescript?.version ?? ''),
    toolchainFingerprint: `typescript@${expectedTypeScriptVersion ?? String(typescript?.version ?? '')};tsconfig=${tsconfigPath}`
  });

  const initialProfile = await profileRepository(root, {
    repositoryId: repository.repository_id,
    snapshotId: snapshot.snapshot_id,
    providerManifests: [provider.manifest]
  });
  const sourceTextByPath = await sourceTextMap(root, initialProfile.files);
  const run = await runFabricProvider(provider, {
    rootDirectory: root,
    tsconfigPath,
    scope: { type: 'REPOSITORY' }
  }, {
    repositoryId: repository.repository_id,
    snapshotId: snapshot.snapshot_id,
    sourceTextByPath
  });
  const failureReason = run.failures.map(item => `${item.failure_type}:${item.message}`).join('; ') || null;
  const receipts = executionReceipts(initialProfile, provider, run.execution_status === 'ANALYZED' ? 'ANALYZED' : 'FAILED', failureReason);
  const coverage = buildCapabilityCoverage(initialProfile.files, {
    providerManifests: [provider.manifest],
    executionReceipts: receipts
  });
  const relevantCoverage = coverage.filter(item => {
    const file = initialProfile.files.find(candidate => candidate.path === item.scope?.path);
    return file?.primary_language === 'TYPESCRIPT';
  });
  const fusion = fuseAnalyzerObservations(run.observations);
  const ledger = buildCoreEvidenceLedgerFromFabric({
    repositoryId: repository.repository_id,
    snapshotId: snapshot.snapshot_id,
    observations: run.observations,
    fabricCoverage: relevantCoverage
  });
  if (ledger.claims.length !== 0) throw new Error('INTERNAL_INVARIANT: Fabric evidence bridge must not create canonical claims');

  return {
    schema: 'kneekura.typescript-semantic-vertical/v1',
    repository,
    snapshot,
    provider_manifest: provider.manifest,
    profile: {
      schema: initialProfile.schema,
      repository: initialProfile.repository,
      files: initialProfile.files,
      coverage: relevantCoverage,
      summary: initialProfile.summary
    },
    execution: run,
    fusion,
    evidence_ledger: ledger,
    summary: {
      typescript_files: initialProfile.files.filter(file => file.primary_language === 'TYPESCRIPT').length,
      observations: run.observations.length,
      evidence: ledger.evidence.length,
      canonical_claims: ledger.claims.length,
      fabric_failures: run.failures.length,
      core_coverage_completeness: ledger.coverage?.completeness ?? null
    }
  };
}
