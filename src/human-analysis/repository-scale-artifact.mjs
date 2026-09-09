import crypto from 'node:crypto';

import {
  compileProductionHumanExperienceArtifactWithTechnicalViews
} from './technical-artifact.mjs';
import {
  HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
  HUMAN_ARTIFACT_MANIFEST_SCHEMA
} from './artifact-compiler.mjs';
import {
  assertProductionHumanAnalysisIr
} from './production.mjs';
import {
  HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA,
  validateRepositoryScaleReadiness
} from './repository-scale-readiness.mjs';
import {
  buildStandaloneHumanExplorerShell,
  injectHumanExperienceOfflinePayloadStreaming
} from '../human-experience/standalone-explorer.mjs';
import { createDeterministicZip } from './zip.mjs';
import { stableDigest } from './schema.mjs';

const OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';
const SOURCE_BUNDLE_SCHEMA =
  'kneekura.human-analysis-source-bundle/v1';
const R4_DEDUPLICATED_SIDECARS = Object.freeze([
  'explorer-projection.json'
]);
const REQUIRED_PREBUILT_SIDECARS = Object.freeze([
  'analysis.json',
  'coverage.json',
  'experience.json',
  'technical-views.json'
]);
const TECHNICAL_BASE_CACHE = new WeakMap();

export async function compileProductionRepositoryScaleHumanExplorerArtifact({
  experience,
  sources,
  presentation,
  technicalViews,
  repositoryScale,
  repositoryAuthoringIr,
  repositorySources = [],
  title = null,
  explorerShell = null,
  prebuiltTechnicalBase = null
} = {}) {
  validateRepositoryScaleReadiness(repositoryScale);
  if (
    repositoryScale.schema !== HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA ||
    repositoryScale.readiness?.repository_scale_ready !== true
  ) {
    throw new TypeError('repository-scale artifact requires READY_REPOSITORY_SCALE');
  }
  assertRepositoryScaleIdentity(repositoryScale, experience);
  assertRepositoryInventory(repositoryScale, experience);
  assertRepositoryAuthoring(repositoryScale, repositoryAuthoringIr);

  const { shell, base, sourceBundle } = await resolveTechnicalBaseArtifact({
    experience,
    sources,
    presentation,
    technicalViews,
    title,
    explorerShell,
    prebuiltTechnicalBase
  });
  const baseSources = sourceBundle ?? sourceBundleFromArtifact(base);
  const payload = {
    schema: OFFLINE_PAYLOAD_SCHEMA,
    experience,
    sources: {
      ...baseSources,
      records: mergeSourceRecords(
        baseSources.records,
        repositorySources
      )
    },
    ...(presentation == null ? {} : { presentation }),
    technical_views: technicalViews,
    repository_scale: repositoryScale,
    repository_scale_authoring_ir: repositoryAuthoringIr
  };
  const indexHtml = await injectHumanExperienceOfflinePayloadStreaming(shell, {
    payload,
    title: base.manifest.title
  });

  const primary = new Map(
    base.files.map(file => [file.path, file.content])
  );
  primary.set('index.html', indexHtml);
  primary.set('sources.json', stableJson(payload.sources));
  primary.set('repository-scale.json', stableJson(repositoryScale));
  primary.set('repository-authoring-analysis.json', stableJson(repositoryAuthoringIr));

  const manifestCore = structuredClone(base.manifest);
  delete manifestCore.artifact_id;
  delete manifestCore.files;
  manifestCore.offline_payload_digest = stableDigest(payload);
  manifestCore.security = {
    ...manifestCore.security,
    embedded_payload_encoding: 'BASE64_GZIP_JSON_ENVELOPE'
  };
  manifestCore.semantic_readiness = {
    ...manifestCore.semantic_readiness,
    repository_scale_ready: true,
    repository_scale_readiness_id: repositoryScale.readiness_id
  };
  manifestCore.repository_scale = {
    schema: HUMAN_ANALYSIS_REPOSITORY_SCALE_SCHEMA,
    readiness_id: repositoryScale.readiness_id,
    authoring_ir_digest: repositoryAuthoringIr.ir_digest,
    batch_count: repositoryScale.batches.length,
    deduplicated_sidecars: [...R4_DEDUPLICATED_SIDECARS]
  };
  manifestCore.files = [...primary.entries()]
    .map(([filePath, content]) => ({
      path: filePath,
      digest: digestBytes(content),
      bytes: Buffer.byteLength(content)
    }))
    .sort((a, b) => compareText(a.path, b.path));

  const artifactId =
    'artifact:sha256:' + stableDigest(manifestCore).slice('sha256:'.length);
  const manifest = { ...manifestCore, artifact_id: artifactId };
  const files = [...primary.entries()]
    .map(([filePath, content]) => ({ path: filePath, content }));
  files.push({ path: 'manifest.json', content: stableJson(manifest) });
  files.sort((a, b) => compareText(a.path, b.path));
  const zip = createDeterministicZip(
    files.map(file => ({ path: file.path, data: file.content }))
  );
  return deepFreeze({
    schema: HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
    artifact_id: artifactId,
    ir_digest: experience.derived.human_analysis_ir.ir_digest,
    manifest,
    files,
    index_html: indexHtml,
    zip_bytes: zip,
    zip_digest: digestBytes(zip)
  });
}

async function resolveTechnicalBaseArtifact({
  experience,
  sources,
  presentation,
  technicalViews,
  title,
  explorerShell,
  prebuiltTechnicalBase
}) {
  if (prebuiltTechnicalBase != null) {
    const shell = explorerShell ?? await buildStandaloneHumanExplorerShell();
    return projectPrebuiltTechnicalBaseArtifact({
      prebuiltTechnicalBase,
      experience,
      sources,
      presentation,
      technicalViews,
      title,
      shell
    });
  }

  if (!experience || typeof experience !== 'object') {
    const shell = explorerShell ?? await buildStandaloneHumanExplorerShell();
    const compiled = await compileProductionHumanExperienceArtifactWithTechnicalViews({
      experience,
      sources,
      presentation,
      technicalViews,
      title,
      explorerShell: shell
    });
    const base = projectTechnicalBaseArtifact(compiled);
    return { shell, base, sourceBundle: sourceBundleFromArtifact(base) };
  }

  const cached = TECHNICAL_BASE_CACHE.get(experience);
  if (
    cached &&
    cached.sources === sources &&
    cached.presentation === presentation &&
    cached.technicalViews === technicalViews &&
    cached.title === title &&
    (explorerShell == null || cached.shell === explorerShell)
  ) {
    return {
      shell: cached.shell,
      base: cached.base,
      sourceBundle: cached.sourceBundle
    };
  }

  const shell = explorerShell ?? await buildStandaloneHumanExplorerShell();
  const compiled = await compileProductionHumanExperienceArtifactWithTechnicalViews({
    experience,
    sources,
    presentation,
    technicalViews,
    title,
    explorerShell: shell
  });
  const base = projectTechnicalBaseArtifact(compiled);
  const sourceBundle = sourceBundleFromArtifact(base);
  TECHNICAL_BASE_CACHE.set(experience, {
    sources,
    presentation,
    technicalViews,
    title,
    shell,
    base,
    sourceBundle
  });
  return { shell, base, sourceBundle };
}

function projectPrebuiltTechnicalBaseArtifact({
  prebuiltTechnicalBase,
  experience,
  sources,
  presentation,
  technicalViews,
  title,
  shell
}) {
  const value = prebuiltTechnicalBase;
  if (!value || typeof value !== 'object') {
    throw new TypeError('prebuilt technical base must be an object');
  }
  const manifest = value.manifest;
  if (
    !manifest ||
    manifest.schema !== HUMAN_ARTIFACT_MANIFEST_SCHEMA ||
    typeof manifest.artifact_id !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    throw new TypeError('prebuilt technical base manifest is invalid');
  }
  const manifestCore = structuredClone(manifest);
  delete manifestCore.artifact_id;
  const expectedArtifactId =
    'artifact:sha256:' + stableDigest(manifestCore).slice('sha256:'.length);
  if (manifest.artifact_id !== expectedArtifactId) {
    throw new TypeError('prebuilt technical base manifest digest mismatch');
  }

  const ir = experience?.derived?.human_analysis_ir;
  assertProductionHumanAnalysisIr(ir);
  if (
    manifest.repository?.repository_id !== experience?.repository?.repository_id ||
    manifest.repository?.snapshot_id !== experience?.repository?.snapshot_id ||
    manifest.ir_digest !== ir.ir_digest ||
    manifest.human_experience_projection_id !== experience?.projection_id
  ) {
    throw new TypeError('prebuilt technical base identity mismatch');
  }
  if (
    manifest.technical_views?.view_set_id !== technicalViews?.view_set_id
  ) {
    throw new TypeError('prebuilt technical base technical-view identity mismatch');
  }
  if (
    presentation != null &&
    manifest.semantic_readiness?.presentation_id !== presentation.presentation_id
  ) {
    throw new TypeError('prebuilt technical base presentation identity mismatch');
  }

  const sourceBundle = value.sourceBundle;
  if (
    !sourceBundle ||
    sourceBundle.schema !== SOURCE_BUNDLE_SCHEMA ||
    sourceBundle.repository?.repository_id !== experience.repository.repository_id ||
    sourceBundle.repository?.snapshot_id !== experience.repository.snapshot_id ||
    sourceBundle.ir_digest !== ir.ir_digest ||
    !Array.isArray(sourceBundle.records)
  ) {
    throw new TypeError('prebuilt technical base source bundle identity mismatch');
  }
  if (
    sourceBundle.records !== sources &&
    stableDigest(sourceBundle.records) !== stableDigest(sources)
  ) {
    throw new TypeError('prebuilt technical base source records mismatch');
  }

  if (!Array.isArray(value.files)) {
    throw new TypeError('prebuilt technical base files must be an array');
  }
  const manifestFileMeta = new Map(
    manifest.files.map(file => [file.path, file])
  );
  const fileMap = new Map();
  for (const file of value.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      file.path === 'manifest.json' ||
      file.path === 'index.html' ||
      R4_DEDUPLICATED_SIDECARS.includes(file.path)
    ) {
      throw new TypeError(`prebuilt technical base file is invalid: ${String(file?.path)}`);
    }
    if (fileMap.has(file.path)) {
      throw new TypeError(`prebuilt technical base file is duplicated: ${file.path}`);
    }
    const meta = manifestFileMeta.get(file.path);
    if (
      !meta ||
      meta.digest !== digestBytes(file.content) ||
      meta.bytes !== Buffer.byteLength(file.content)
    ) {
      throw new TypeError(`prebuilt technical base file digest mismatch: ${file.path}`);
    }
    fileMap.set(file.path, file.content);
  }
  for (const required of REQUIRED_PREBUILT_SIDECARS) {
    if (!fileMap.has(required)) {
      throw new TypeError(`prebuilt technical base sidecar is missing: ${required}`);
    }
  }
  if (presentation != null && !fileMap.has('presentation.json')) {
    throw new TypeError('prebuilt technical base presentation sidecar is missing');
  }

  fileMap.set(
    'README.md',
    renderProductionReadme(
      ir,
      normalizeTitle(title),
      presentation?.readiness ?? null
    )
  );
  const projectedManifest = {
    ...structuredClone(manifest),
    title: normalizeTitle(title),
    human_explorer_shell_digest: shell.digest
  };
  return {
    shell,
    base: deepFreeze({
      manifest: projectedManifest,
      files: [...fileMap.entries()]
        .filter(([filePath]) => filePath !== 'sources.json')
        .map(([filePath, content]) => ({ path: filePath, content }))
        .sort((a, b) => compareText(a.path, b.path))
    }),
    sourceBundle
  };
}

function projectTechnicalBaseArtifact(artifact) {
  return deepFreeze({
    manifest: artifact.manifest,
    files: artifact.files
      .filter(file =>
        file.path !== 'manifest.json' &&
        file.path !== 'index.html' &&
        !R4_DEDUPLICATED_SIDECARS.includes(file.path)
      )
      .map(file => ({ path: file.path, content: file.content }))
  });
}

function assertRepositoryScaleIdentity(scale, experience) {
  const repo = experience?.repository;
  if (
    !repo ||
    scale.repository?.repository_id !== repo.repository_id ||
    scale.repository?.snapshot_id !== repo.snapshot_id
  ) {
    throw new TypeError('repository-scale artifact repository/snapshot identity mismatch');
  }
  const authority = scale.authority ?? {};
  if (
    authority.canonical_authority !== false ||
    authority.may_mint_canonical_nodes !== false ||
    authority.may_mint_canonical_edges !== false ||
    authority.may_mint_canonical_claims !== false ||
    authority.derived_readiness_only !== true
  ) {
    throw new TypeError('repository-scale artifact authority boundary violation');
  }
}

function assertRepositoryInventory(scale, experience) {
  const expected = (experience?.source_index?.files ?? [])
    .map(row => ({
      path: row.path,
      content_digest: row.content_digest,
      line_count: row.line_count
    }))
    .sort((a, b) => compareText(a.path, b.path));
  const actual = scale.inventory.files
    .map(row => ({
      path: row.path,
      content_digest: row.content_digest,
      line_count: row.line_count
    }))
    .sort((a, b) => compareText(a.path, b.path));
  if (stableDigest(actual) !== stableDigest(expected)) {
    throw new TypeError('repository-scale artifact inventory/source-index mismatch');
  }
}

function assertRepositoryAuthoring(scale, ir) {
  assertProductionHumanAnalysisIr(ir);
  if (
    ir.repository.repository_id !== scale.repository.repository_id ||
    ir.repository.snapshot_id !== scale.repository.snapshot_id
  ) {
    throw new TypeError('repository-scale authoring IR identity mismatch');
  }
  const accepted = new Set(ir.review?.accepted_item_ids ?? []);
  const domainItems = (ir.items ?? []).filter(item =>
    item.stage === 'DOMAIN' && accepted.has(item.id)
  );
  const itemBatchIds = domainItems
    .map(item => item.metadata?.repository_scale_batch_id)
    .filter(Boolean)
    .sort(compareText);
  const scaleBatchIds = scale.batches.map(row => row.batch_id).sort(compareText);
  if (
    domainItems.length !== scale.batches.length ||
    stableDigest(itemBatchIds) !== stableDigest(scaleBatchIds)
  ) {
    throw new TypeError('repository-scale authoring IR does not cover every reviewed batch');
  }
}

function sourceBundleFromArtifact(artifact) {
  const sourceFile = artifact.files.find(file => file.path === 'sources.json');
  if (!sourceFile || typeof sourceFile.content !== 'string') {
    throw new TypeError('repository-scale base source bundle is missing');
  }
  const bundle = JSON.parse(sourceFile.content);
  if (bundle?.schema !== SOURCE_BUNDLE_SCHEMA) {
    throw new TypeError('repository-scale base source bundle schema is invalid');
  }
  return bundle;
}

function mergeSourceRecords(base, extra) {
  const map = new Map();
  for (const record of [...(base ?? []), ...(extra ?? [])]) {
    const key = sourceKey(record?.ref);
    if (!key) throw new TypeError('repository-scale source record ref is invalid');
    const existing = map.get(key);
    if (existing && stableDigest(existing) !== stableDigest(record)) {
      throw new TypeError(`repository-scale source record conflict: ${key}`);
    }
    map.set(key, record);
  }
  return [...map.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([, record]) => record);
}

function sourceKey(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (String(ref.kind).toUpperCase() === 'FILE_RANGE') {
    return [
      'FILE_RANGE', ref.path, ref.start_line, ref.end_line, ref.content_digest ?? ''
    ].join(':');
  }
  return `${String(ref.kind ?? '').toUpperCase()}:${String(ref.id ?? '')}`;
}

function renderProductionReadme(ir, title, readiness = null) {
  return `# ${title}\n\nPortable KNEEKURA Human Explorer production artifact.\n\n- IR: ${ir.ir_digest}\n- Repository: ${ir.repository.repository_id}\n- Snapshot: ${ir.repository.snapshot_id}\n- Renderer: HUMAN_EXPLORER_V2\n- Semantic readiness: ${readiness?.status ?? 'UNASSESSED'}\n- Repository-scale ready: ${readiness?.repository_scale_ready === true ? 'yes' : 'no'}\n- The full ReactFlow/ELK Human Explorer is bundled into index.html.\n- Repository/source text remains inert data and never gains instruction authority.\n- Open index.html directly in a browser; no server or network connection is required.\n`;
}

function normalizeTitle(title) {
  const value = String(title ?? 'KNEEKURA Human Analysis').trim();
  if (!value) throw new TypeError('artifact title must not be empty');
  return value.slice(0, 200);
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2) + '\n';
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])])
    );
  }
  return value;
}

function digestBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}