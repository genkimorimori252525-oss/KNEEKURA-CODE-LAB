import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createEngineRunReceipt } from '../contracts.mjs';
import { readEngineLock } from '../engine-lock.mjs';
import { createSanitizedReceipt, createSkillDeliveryZip, sanitizeDiagnosticText } from '../runtime.mjs';

export const UNDERSTAND_ANYTHING_SKILL_ENGINE_RESULT_SCHEMA = 'kneekura.code-lab.understand-anything-engine-result/v1';
const FILE_LEVEL_TYPES = new Set(['file','config','document','service','pipeline','table','schema','resource','endpoint']);
const CLAIM_RANK = Object.freeze({ FALLBACK_PREVIEW: 0, COMPATIBLE: 1, PORTABLE: 2, NATIVE: 3 });
const UA_SELF_PATH = /^(?:\.ua|\.understand-anything)(?:\/|$)/;

export async function runStableUnderstandAnythingEngine({
  uaRoot, targetRoot, targetSnapshotId, targetRevision, analysisViewPrivate = false,
  analysisViewManifest = null, semanticScheduler, runRoot, attemptId, scopeDigest,
  minimumClaimLevel = null, hostCapabilities = {}, dashboardRoot = null,
  dashboardAcceptance = { status: 'SKIPPED', reason: 'browser acceptance not performed' },
  execute = executeUaHelper
} = {}) {
  const root = path.resolve(requireText(uaRoot, 'uaRoot'));
  const target = path.resolve(requireText(targetRoot, 'targetRoot'));
  path.resolve(requireText(runRoot, 'runRoot'));
  const snapshotId = requireText(targetSnapshotId, 'targetSnapshotId');
  const revision = requireText(targetRevision, 'targetRevision');
  const attempt = requireText(attemptId, 'attemptId');
  const scope = requireText(scopeDigest, 'scopeDigest');
  if (analysisViewPrivate !== true) throw codedError('UA_PRIVATE_ANALYSIS_VIEW_REQUIRED', 'Understand Anything may write only inside a private disposable Analysis View');
  const scheduler = normalizeScheduler(semanticScheduler, hostCapabilities);
  const lock = await readEngineLock();
  const pinned = lock.engines['understand-anything'];
  await assertUpstreamIdentity(root, pinned);

  const pluginRoot = path.join(root, 'understand-anything-plugin');
  const skillDir = path.join(pluginRoot, 'skills', 'understand');
  const uaDir = path.join(target, '.ua');
  const intermediate = path.join(uaDir, 'intermediate');
  const tmp = path.join(uaDir, 'tmp');
  await fs.mkdir(intermediate, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  const selfExclusion = await enforceSelfExclusion(target);
  const invoke = async (helper, args) => {
    const result = await execute({ helper, uaRoot: root, pluginRoot, skillDir, targetRoot: target, args });
    if (!result || result.status !== 0) {
      const error = codedError('UA_UPSTREAM_HELPER_FAILED', `Understand Anything helper failed: ${helper}`);
      error.details = { helper, status: result?.status ?? null, stderr: sanitizeDiagnosticText(result?.stderr ?? '', { maxBytes: 16384 }) };
      throw error;
    }
    return result;
  };

  const scanRawPath = path.join(tmp, 'ua-scan-files.json');
  await invoke('scan-project', [target, scanRawPath]);
  const scanRaw = JSON.parse(await fs.readFile(scanRawPath, 'utf8'));
  assertScanResult(scanRaw);
  const projectNarrative = await scheduler.dispatch('project-scanner', deepFreeze({ schema: 'kneekura.code-lab.ua-role-input/v1', projectRoot: target, scan: scanRaw, outputLanguage: 'ja', upstreamAgent: 'project-scanner' }));
  assertNarrative(projectNarrative);

  const importInputPath = path.join(tmp, 'ua-import-map-input.json');
  const importOutputPath = path.join(tmp, 'ua-import-map-output.json');
  await fs.writeFile(importInputPath, stableJson({ projectRoot: target, files: scanRaw.files }));
  await invoke('extract-import-map', [importInputPath, importOutputPath]);
  const importRaw = JSON.parse(await fs.readFile(importOutputPath, 'utf8'));
  if (importRaw?.scriptCompleted !== true || !importRaw.importMap || typeof importRaw.importMap !== 'object') throw codedError('UA_IMPORT_MAP_INVALID', 'Understand Anything import-map helper returned invalid output');
  const scan = { name: projectNarrative.name, description: projectNarrative.description, languages: [...projectNarrative.languages], frameworks: [...projectNarrative.frameworks], files: scanRaw.files, totalFiles: scanRaw.totalFiles, filteredByIgnore: scanRaw.filteredByIgnore, estimatedComplexity: scanRaw.estimatedComplexity, importMap: importRaw.importMap };
  await fs.writeFile(path.join(intermediate, 'scan-result.json'), stableJson(scan));
  await invoke('compute-batches', [target]);
  const batches = JSON.parse(await fs.readFile(path.join(intermediate, 'batches.json'), 'utf8'));
  if (!Array.isArray(batches?.batches)) throw codedError('UA_BATCHES_INVALID', 'Understand Anything batches.json is invalid');

  const roleStats = { projectScanner: 1, fileAnalyzer: 0, assembleReviewer: 0, architectureAnalyzer: 0, tourBuilder: 0 };
  for (const batch of batches.batches) {
    const batchIndex = Number(batch.batchIndex);
    if (!Number.isInteger(batchIndex) || batchIndex < 1 || !Array.isArray(batch.files)) throw codedError('UA_BATCH_INVALID', 'Understand Anything batch is invalid');
    const extractInput = path.join(tmp, `ua-file-analyzer-input-${batchIndex}.json`);
    const extractOutput = path.join(tmp, `ua-file-extract-results-${batchIndex}.json`);
    await fs.writeFile(extractInput, stableJson({ projectRoot: target, batchFiles: batch.files, batchImportData: batch.batchImportData ?? {} }));
    await invoke('extract-structure', [extractInput, extractOutput]);
    const extracted = JSON.parse(await fs.readFile(extractOutput, 'utf8'));
    if (extracted?.scriptCompleted !== true || !Array.isArray(extracted.results)) throw codedError('UA_STRUCTURE_INVALID', `Understand Anything structural extraction invalid for batch ${batchIndex}`);
    const fragment = await scheduler.dispatch('file-analyzer', deepFreeze({ schema: 'kneekura.code-lab.ua-role-input/v1', projectRoot: target, batchIndex, batchFiles: batch.files, batchImportData: batch.batchImportData ?? {}, neighborMap: batch.neighborMap ?? {}, extraction: extracted, upstreamAgent: 'file-analyzer' }));
    const parts = normalizeGraphFragment(fragment, batchIndex);
    for (let i = 0; i < parts.length; i += 1) {
      const suffix = parts.length === 1 ? '' : `-part-${i + 1}`;
      await fs.writeFile(path.join(intermediate, `batch-${batchIndex}${suffix}.json`), stableJson(parts[i]));
    }
    roleStats.fileAnalyzer += 1;
  }

  await invoke('merge-batch-graphs', [target]);
  const assembled = JSON.parse(await fs.readFile(path.join(intermediate, 'assembled-graph.json'), 'utf8'));
  if (!Array.isArray(assembled?.nodes) || !Array.isArray(assembled?.edges)) throw codedError('UA_ASSEMBLED_GRAPH_INVALID', 'Understand Anything assembled graph is invalid');
  await scheduler.dispatch('assemble-reviewer', deepFreeze({ schema: 'kneekura.code-lab.ua-role-input/v1', projectRoot: target, nodes: assembled.nodes, edges: assembled.edges, upstreamAgent: 'assemble-reviewer' }));
  roleStats.assembleReviewer = 1;
  const layers = await scheduler.dispatch('architecture-analyzer', deepFreeze({ schema: 'kneekura.code-lab.ua-role-input/v1', projectRoot: target, nodes: assembled.nodes, edges: assembled.edges, upstreamAgent: 'architecture-analyzer' }));
  roleStats.architectureAnalyzer = 1;
  const tour = await scheduler.dispatch('tour-builder', deepFreeze({ schema: 'kneekura.code-lab.ua-role-input/v1', projectRoot: target, nodes: assembled.nodes, edges: assembled.edges, layers, upstreamAgent: 'tour-builder' }));
  roleStats.tourBuilder = 1;

  const graph = { version: '1.0.0', project: { name: scan.name, languages: scan.languages, frameworks: scan.frameworks, description: scan.description, analyzedAt: new Date().toISOString(), gitCommitHash: revision }, nodes: assembled.nodes, edges: assembled.edges, layers, tour };
  const graphValidation = validateUaKnowledgeGraph(graph);
  if (!graphValidation.ok) throw codedError('UA_GRAPH_VALIDATION_FAILED', graphValidation.issues.join('; '));
  assertNoSelfContamination(scan.files, graph.nodes);
  const coverage = reconcileUaCoverage(analysisViewManifest, scan.files);
  const graphPath = path.join(uaDir, 'knowledge-graph.json');
  await fs.writeFile(graphPath, stableJson(graph));
  const fingerprintInput = path.join(intermediate, 'fingerprint-input.json');
  await fs.writeFile(fingerprintInput, stableJson({ projectRoot: target, sourceFilePaths: scan.files.map(file => file.path), gitCommitHash: revision }));
  const fingerprints = await invoke('build-fingerprints', [fingerprintInput]);
  if (!String(fingerprints.stdout ?? '').includes('Fingerprints baseline:')) throw codedError('UA_FINGERPRINTS_INVALID', 'Understand Anything fingerprint helper did not confirm baseline creation');
  await fs.writeFile(path.join(uaDir, 'meta.json'), stableJson({ lastAnalyzedAt: graph.project.analyzedAt, gitCommitHash: revision, version: '1.0.0', analyzedFiles: scan.totalFiles }));

  const graphBytes = await fs.readFile(graphPath);
  const dashboard = await collectDashboardArtifact(root, dashboardRoot, dashboardAcceptance);
  const warnings = [];
  if (coverage.missingHostSemanticInputs.length) warnings.push(`UA scan omitted ${coverage.missingHostSemanticInputs.length} host semantic-input path(s); exhaustive coverage is not satisfied.`);
  if (dashboard.acceptance.status !== 'PASSED') warnings.push(`UA dashboard acceptance is ${dashboard.acceptance.status}: ${dashboard.acceptance.reason}`);
  const status = coverage.missingHostSemanticInputs.length === 0 ? 'SUCCESS' : 'PARTIAL';
  const claimSatisfied = claimMeetsMinimum(scheduler.claimLevel, minimumClaimLevel) && coverage.missingHostSemanticInputs.length === 0;
  const entries = [
    { classification: 'ENGINE_ARTIFACT', path: 'engines/understand-anything/knowledge-graph.json', data: graphBytes },
    { classification: 'SANITIZED_RECEIPT', path: 'engines/understand-anything/graph-validation.receipt.json', data: stableJson(createSanitizedReceipt(graphValidation)) }
  ];
  for (const file of dashboard.files) entries.push({ classification: 'ENGINE_ARTIFACT', path: `engines/understand-anything/dashboard/${file.path}`, data: file.bytes });
  const deliveryZip = createSkillDeliveryZip(entries);
  const graphSha = sha256(graphBytes);
  const zipSha = sha256(deliveryZip);
  const receipt = createEngineRunReceipt({
    engineId: 'understand-anything', implementationOrigin: 'pinned-upstream', implementationVersion: pinned.version,
    orchestrationMode: scheduler.orchestrationMode, snapshotId, scopeDigest: scope, attemptId: attempt,
    status, claimLevel: scheduler.claimLevel, minimumClaimLevel, claimSatisfied,
    acceptance: {
      upstream_release: pinned.release, upstream_commit: pinned.commit, upstream_plugin_tree: pinned.pluginTree.value, upstream_skill_blob: pinned.skillContract.value,
      scheduler: { mode: scheduler.mode, isolation: scheduler.isolation, native_requirements_satisfied: scheduler.claimLevel === 'NATIVE', roles: roleStats },
      self_exclusion: selfExclusion,
      graph: { status: 'PASSED', sha256: graphSha, ...graphValidation }, dashboard: dashboard.acceptance
    },
    coverage: { ua_scanned_files: scan.totalFiles, filtered_by_target_understandignore: scan.filteredByIgnore, host_semantic_inputs: coverage.hostSemanticInputs, missing_host_semantic_inputs: coverage.missingHostSemanticInputs },
    artifacts: [
      { kind: 'UA_KNOWLEDGE_GRAPH', digest: `sha256:${graphSha}`, bytes: graphBytes.length },
      ...(dashboard.files.length ? [{ kind: 'UA_DASHBOARD', digest: dashboard.digest, bytes: dashboard.bytes }] : []),
      { kind: 'UA_SKILL_ZIP', digest: `sha256:${zipSha}`, bytes: deliveryZip.length }
    ], warnings, errors: [], hostCapabilities
  });
  return Object.freeze({ schema: UNDERSTAND_ANYTHING_SKILL_ENGINE_RESULT_SCHEMA, engineId: 'understand-anything', graph, graphPath, dashboard: deepFreeze({ acceptance: dashboard.acceptance, digest: dashboard.digest, bytes: dashboard.bytes }), deliveryZip, deliveryZipDigest: `sha256:${zipSha}`, receipt });
}

export function classifyUaOrchestration(semanticScheduler, hostCapabilities = {}) {
  const mode = String(semanticScheduler?.mode ?? 'portable-compatible');
  const isolation = String(semanticScheduler?.isolation ?? 'shared-context');
  const native = mode === 'native-upstream-subagents' && isolation === 'separate-contexts' && hostCapabilities.semanticSubagentIsolation === true;
  return Object.freeze({ mode, isolation, orchestrationMode: native ? 'native' : 'portable-compatible', claimLevel: native ? 'NATIVE' : 'COMPATIBLE' });
}

export function validateUaKnowledgeGraph(graph) {
  const issues = [];
  if (!graph || typeof graph !== 'object') return { ok: false, issues: ['graph is not an object'] };
  if (!Array.isArray(graph.nodes)) issues.push('graph.nodes is missing or not an array');
  if (!Array.isArray(graph.edges)) issues.push('graph.edges is missing or not an array');
  if (!Array.isArray(graph.layers)) issues.push('graph.layers is missing or not an array');
  if (!Array.isArray(graph.tour)) issues.push('graph.tour is missing or not an array');
  if (issues.length) return { ok: false, issues };
  const nodeIds = new Set();
  for (const [index, node] of graph.nodes.entries()) {
    if (!node?.id || !node?.type || !node?.name || !node?.summary || !Array.isArray(node?.tags) || node.tags.length === 0) { issues.push(`node[${index}] missing required UA fields`); continue; }
    if (nodeIds.has(node.id)) issues.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  for (const [index, edge] of graph.edges.entries()) if (!nodeIds.has(edge?.source) || !nodeIds.has(edge?.target)) issues.push(`edge[${index}] has dangling endpoint`);
  const layerAssignment = new Map();
  for (const layer of graph.layers) {
    if (!layer?.id || !layer?.name || !layer?.description || !Array.isArray(layer?.nodeIds)) { issues.push('layer missing required UA fields'); continue; }
    for (const id of layer.nodeIds) {
      if (!nodeIds.has(id)) issues.push(`layer ${layer.id} references missing node ${id}`);
      if (layerAssignment.has(id)) issues.push(`node ${id} appears in multiple layers`);
      layerAssignment.set(id, layer.id);
    }
  }
  for (const node of graph.nodes) if (FILE_LEVEL_TYPES.has(node.type) && !layerAssignment.has(node.id)) issues.push(`file-level node ${node.id} is not assigned to a layer`);
  for (const [index, step] of graph.tour.entries()) {
    if (!Number.isFinite(Number(step?.order)) || !step?.title || !step?.description || !Array.isArray(step?.nodeIds)) { issues.push(`tour[${index}] missing required UA fields`); continue; }
    for (const id of step.nodeIds) if (!nodeIds.has(id)) issues.push(`tour[${index}] references missing node ${id}`);
  }
  return { ok: issues.length === 0, issues, stats: { nodes: graph.nodes.length, edges: graph.edges.length, layers: graph.layers.length, tour: graph.tour.length } };
}

export function reconcileUaCoverage(manifest, scannedFiles) {
  const hostSemanticInputs = Array.isArray(manifest?.entries) ? manifest.entries.filter(entry => entry?.classification === 'semantic-input').map(entry => normalizeRel(entry.path)) : [];
  const scanned = new Set((scannedFiles ?? []).map(file => normalizeRel(file.path)));
  return Object.freeze({ hostSemanticInputs, missingHostSemanticInputs: hostSemanticInputs.filter(file => !scanned.has(file)) });
}

export async function executeUaHelper({ helper, skillDir, targetRoot, args = [], timeoutMs = 180000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const helpers = {
    'scan-project': { exe: process.execPath, script: path.join(skillDir, 'scan-project.mjs') },
    'extract-import-map': { exe: process.execPath, script: path.join(skillDir, 'extract-import-map.mjs') },
    'compute-batches': { exe: process.execPath, script: path.join(skillDir, 'compute-batches.mjs') },
    'extract-structure': { exe: process.execPath, script: path.join(skillDir, 'extract-structure.mjs') },
    'build-fingerprints': { exe: process.execPath, script: path.join(skillDir, 'build-fingerprints.mjs') },
    'merge-batch-graphs': { exe: process.env.KNEEKURA_UA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), script: path.join(skillDir, 'merge-batch-graphs.py') }
  };
  const selected = helpers[helper];
  if (!selected) throw codedError('UA_HELPER_NOT_ALLOWLISTED', `UA helper is not allowlisted: ${helper}`);
  return new Promise(resolve => childProcess.execFile(selected.exe, [selected.script, ...args], {
    cwd: targetRoot, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer,
    env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }).filter(([, value]) => value != null))
  }, (error, stdout, stderr) => resolve({ status: error == null ? 0 : Number.isInteger(error.code) ? error.code : 1, signal: error?.signal ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error == null ? null : String(error.message ?? error) })));
}

function normalizeScheduler(value, hostCapabilities) {
  if (!value || typeof value !== 'object' || typeof value.dispatch !== 'function') throw codedError('UA_SEMANTIC_SCHEDULER_REQUIRED', 'Understand Anything requires a host semantic scheduler');
  return Object.freeze({ ...classifyUaOrchestration(value, hostCapabilities), dispatch: value.dispatch });
}

async function assertUpstreamIdentity(root, pinned) {
  const rootPackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const pluginPackage = JSON.parse(await fs.readFile(path.join(root, 'understand-anything-plugin', 'package.json'), 'utf8'));
  if (rootPackage.name !== 'understand-anything' || pluginPackage.name !== '@understand-anything/skill' || pluginPackage.version !== pinned.version) throw codedError('UA_UPSTREAM_VERSION_MISMATCH', `Understand Anything package identity mismatch; expected ${pinned.version}`);
  for (const relative of ['understand-anything-plugin/skills/understand/SKILL.md','understand-anything-plugin/skills/understand/scan-project.mjs','understand-anything-plugin/skills/understand/extract-import-map.mjs','understand-anything-plugin/skills/understand/compute-batches.mjs','understand-anything-plugin/skills/understand/extract-structure.mjs','understand-anything-plugin/skills/understand/merge-batch-graphs.py','understand-anything-plugin/skills/understand/build-fingerprints.mjs']) await assertRegularFile(path.join(root, relative));
}

async function enforceSelfExclusion(target) {
  const git = path.join(target, '.git');
  let stat;
  try { stat = await fs.lstat(git); } catch { return { status: 'NOT_APPLICABLE', reason: 'analysis view is not a git working tree' }; }
  if (!stat.isDirectory()) return { status: 'NOT_APPLICABLE', reason: 'gitdir indirection is owned by the snapshot materializer' };
  const info = path.join(git, 'info');
  await fs.mkdir(info, { recursive: true });
  const exclude = path.join(info, 'exclude');
  let existing = '';
  try { existing = await fs.readFile(exclude, 'utf8'); } catch {}
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  lines.add('.ua/'); lines.add('.understand-anything/');
  await fs.writeFile(exclude, [...lines].join('\n') + '\n', 'utf8');
  return { status: 'PASSED', policy: 'git-local-exclude', paths: ['.ua/', '.understand-anything/'] };
}

function assertScanResult(scan) {
  if (scan?.scriptCompleted !== true || !Array.isArray(scan.files) || scan.totalFiles !== scan.files.length) throw codedError('UA_SCAN_INVALID', 'Understand Anything scan-project output is invalid');
  for (const file of scan.files) if (!file?.path || !file?.language || !file?.fileCategory || !Number.isInteger(file?.sizeLines)) throw codedError('UA_SCAN_INVALID', 'Understand Anything scan entry is invalid');
}
function assertNarrative(value) { if (!value || typeof value !== 'object' || !String(value.name ?? '').trim() || !String(value.description ?? '').trim() || !Array.isArray(value.languages) || !Array.isArray(value.frameworks)) throw codedError('UA_PROJECT_SCANNER_INVALID', 'project-scanner role returned an invalid narrative'); }
function normalizeGraphFragment(value, batchIndex) { const parts = Array.isArray(value?.parts) ? value.parts : [value]; if (!parts.length || parts.some(part => !part || !Array.isArray(part.nodes) || !Array.isArray(part.edges))) throw codedError('UA_FILE_ANALYZER_INVALID', `file-analyzer returned invalid graph fragment for batch ${batchIndex}`); return parts; }
function assertNoSelfContamination(files, nodes) { const contaminated = []; for (const file of files ?? []) if (UA_SELF_PATH.test(normalizeRel(file.path))) contaminated.push(file.path); for (const node of nodes ?? []) if (node?.filePath && UA_SELF_PATH.test(normalizeRel(node.filePath))) contaminated.push(node.filePath); if (contaminated.length) throw codedError('UA_SELF_CONTAMINATION', `UA analysis data entered semantic input: ${[...new Set(contaminated)].join(', ')}`); }

async function collectDashboardArtifact(root, dashboardRoot, acceptanceInput) {
  const acceptance = normalizeDashboardAcceptance(acceptanceInput);
  if (!dashboardRoot) return { files: [], bytes: 0, digest: null, acceptance };
  const resolved = path.resolve(dashboardRoot); const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) throw codedError('UA_DASHBOARD_OUTSIDE_UPSTREAM', 'dashboardRoot must be inside the pinned upstream checkout');
  const files = [];
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw codedError('UA_DASHBOARD_SYMLINK', 'dashboard artifact may not contain symlinks'); if (entry.isDirectory()) await walk(full); else if (entry.isFile()) files.push({ path: normalizeRel(path.relative(resolved, full)), bytes: await fs.readFile(full) }); } }
  await walk(resolved); files.sort((a,b) => compareText(a.path,b.path));
  const digest = `sha256:${sha256(Buffer.concat(files.flatMap(file => [Buffer.from(file.path + '\0'), file.bytes])))}`;
  return { files, bytes: files.reduce((sum,file) => sum + file.bytes.length, 0), digest, acceptance };
}
function normalizeDashboardAcceptance(value) { const status = String(value?.status ?? 'SKIPPED').toUpperCase(); if (!['PASSED','SKIPPED','FAILED'].includes(status)) throw new TypeError(`invalid UA dashboard acceptance status: ${status}`); return Object.freeze({ status, reason: sanitizeDiagnosticText(String(value?.reason ?? '').trim() || 'no reason supplied', { maxBytes: 4096 }), browser_separate_from_graph: true }); }
function claimMeetsMinimum(actual, minimum) { if (minimum == null || minimum === '') return true; const wanted = String(minimum).toUpperCase(); return Number.isInteger(CLAIM_RANK[wanted]) && CLAIM_RANK[actual] >= CLAIM_RANK[wanted]; }
function normalizeRel(value) { return String(value ?? '').replaceAll('\\','/').replace(/^\.\//,''); }
function stableJson(value) { return JSON.stringify(sortObject(value), null, 2) + '\n'; }
function sortObject(value) { if (Array.isArray(value)) return value.map(sortObject); if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])])); return value; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function assertRegularFile(file) { let stat; try { stat = await fs.lstat(file); } catch { throw codedError('UA_REQUIRED_FILE_INVALID', `required UA file missing: ${file}`); } if (!stat.isFile() || stat.isSymbolicLink()) throw codedError('UA_REQUIRED_FILE_INVALID', `required UA file is not a regular file: ${file}`); }
function requireText(value,label) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(`${label} must be a non-empty string`); return text; }
function compareText(a,b) { const left=String(a), right=String(b); return left < right ? -1 : left > right ? 1 : 0; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
function codedError(code,message) { const error = new Error(message); error.code = code; return error; }