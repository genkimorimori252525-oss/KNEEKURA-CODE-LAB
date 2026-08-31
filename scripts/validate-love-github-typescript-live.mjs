import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { runTypeScriptSemanticVertical } from '../src/analyzer-fabric/typescript-vertical.mjs';

const execFileAsync = promisify(execFile);

async function exec(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}


async function runNpm(cwd, args) {
  if (process.env.npm_execpath) {
    return exec(process.execPath, [process.env.npm_execpath, ...args], { cwd });
  }
  if (process.platform === 'win32') {
    return exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd });
  }
  return exec('npm', args, { cwd });
}

async function exists(value) {
  try { await fs.access(value); return true; } catch { return false; }
}

async function isLoveGithubRepo(candidate) {
  if (!candidate || !(await exists(path.join(candidate, '.git')))) return false;
  try {
    const { stdout } = await exec('git', ['-C', candidate, 'remote', 'get-url', 'origin']);
    return /(?:^|[\\/:])Love-Github(?:\.git)?\s*$/i.test(stdout.trim());
  } catch {
    return false;
  }
}

async function discoverLoveGithubRepo() {
  const home = os.homedir();
  const direct = [
    process.env.LOVE_GITHUB_ROOT,
    path.join(home, 'Downloads', 'Love-Github'),
    path.join(home, 'Downloads', 'love-github'),
    path.join(home, 'Desktop', 'Love-Github'),
    path.join(home, 'Documents', 'Love-Github')
  ].filter(Boolean);
  for (const candidate of direct) if (await isLoveGithubRepo(candidate)) return path.resolve(candidate);

  for (const base of [path.join(home, 'Downloads'), path.join(home, 'Desktop')]) {
    let entries = [];
    try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name);
      if (await isLoveGithubRepo(candidate)) return candidate;
      let nested = [];
      try { nested = await fs.readdir(candidate, { withFileTypes: true }); } catch { continue; }
      for (const child of nested) {
        if (!child.isDirectory()) continue;
        const nestedCandidate = path.join(candidate, child.name);
        if (await isLoveGithubRepo(nestedCandidate)) return nestedCandidate;
      }
    }
  }
  throw new Error('LIVE_VALIDATION_REPO_NOT_FOUND: could not locate an existing Love-Github clone on the self-hosted runner');
}

async function resolveTargetCommit(tempRoot, sourceRoot) {
  let remoteUrl = null;
  try { remoteUrl = (await exec('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'])).stdout.trim(); } catch {}
  if (remoteUrl) {
    try {
      await exec('git', ['-C', tempRoot, 'remote', 'set-url', 'origin', remoteUrl]);
      await exec('git', ['-C', tempRoot, 'fetch', '--no-tags', '--prune', 'origin', 'main']);
      return (await exec('git', ['-C', tempRoot, 'rev-parse', 'FETCH_HEAD'])).stdout.trim().toLowerCase();
    } catch (error) {
      process.stderr.write(`Love-Github fetch unavailable; using the existing local clone snapshot: ${String(error?.message ?? error)}\n`);
    }
  }
  return (await exec('git', ['-C', tempRoot, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
}

async function loadSemanticTypeScript() {
  const require = createRequire(import.meta.url);
  const moduleValue = require('@typescript/typescript6');
  return typeof moduleValue?.createProgram === 'function' ? moduleValue : moduleValue.default;
}

async function loadTargetTypeScriptVersion(root) {
  const raw = await fs.readFile(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8');
  return String(JSON.parse(raw).version ?? 'unknown');
}

async function main() {
  const sourceRoot = await discoverLoveGithubRepo();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-love-github-'));
  const tempRoot = path.join(parent, 'repo');
  try {
    await exec('git', ['clone', '--no-hardlinks', '--no-checkout', sourceRoot, tempRoot]);
    const targetCommit = await resolveTargetCommit(tempRoot, sourceRoot);
    await exec('git', ['-C', tempRoot, 'checkout', '--detach', targetCommit]);
    await runNpm(tempRoot, ['install', '--no-audit', '--no-fund', '--package-lock=false']);
    await runNpm(tempRoot, ['run', 'typecheck']);
    const targetTypeScriptVersion = await loadTargetTypeScriptVersion(tempRoot);
    const typescript = await loadSemanticTypeScript();
    const result = await runTypeScriptSemanticVertical({
      rootDirectory: tempRoot,
      commitSha: targetCommit,
      typescript,
      tsconfigPath: 'tsconfig.json',
      expectedTypeScriptVersion: String(typescript.version),
      requireClean: true
    });
    const crossFile = result.execution.observations.filter(item => item.capability === 'CROSS_FILE_REFERENCE').length;
    const resolvedCalls = result.execution.observations.filter(item => item.capability === 'CALL').length;
    const tsxFiles = result.profile.files.filter(item => item.dialect === 'TSX' || item.path.endsWith('.tsx')).length;
    if (result.summary.typescript_files <= 0) throw new Error('LIVE_VALIDATION_EMPTY: Love-Github produced no TypeScript files');
    if (result.summary.observations <= 0 || result.summary.evidence <= 0) throw new Error('LIVE_VALIDATION_EMPTY_EVIDENCE: no semantic observations/evidence were produced');
    if (crossFile <= 0) throw new Error('LIVE_VALIDATION_NO_CROSS_FILE_REFERENCE: expected real repository-local cross-file references');
    if (result.summary.canonical_claims !== 0) throw new Error('LIVE_VALIDATION_CANONICAL_CLAIM_VIOLATION: Fabric bridge created unsupported canonical claims');
    if (result.summary.core_coverage_completeness !== 'BOUNDED') throw new Error(`LIVE_VALIDATION_COVERAGE_OVERCLAIM: expected BOUNDED, got ${result.summary.core_coverage_completeness}`);
    const traced = result.execution.observations.filter(item => item.source_file && item.source_range?.content_digest && Number.isInteger(item.source_range.start_byte) && Number.isInteger(item.source_range.end_byte)).length;
    if (traced !== result.execution.observations.length) throw new Error(`LIVE_VALIDATION_TRACEABILITY_GAP: ${traced}/${result.execution.observations.length} observations have exact source traceability`);
    process.stdout.write(JSON.stringify({
      schema: 'kneekura.live-love-github-typescript-validation/v1',
      source_clone: sourceRoot,
      analyzed_commit: targetCommit,
      target_typescript_version: targetTypeScriptVersion,
      semantic_sidecar_version: String(typescript.version),
      typescript_files: result.summary.typescript_files,
      tsx_files: tsxFiles,
      observations: result.summary.observations,
      evidence: result.summary.evidence,
      cross_file_references: crossFile,
      resolved_calls: resolvedCalls,
      canonical_claims: result.summary.canonical_claims,
      coverage: result.summary.core_coverage_completeness,
      exact_source_traces: traced
    }, null, 2) + '\n');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

await main();
