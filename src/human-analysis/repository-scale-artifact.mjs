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
const R4_DEDUPLICATED_SIDECARS = Object.freeze([
  'explorer-projection.json'
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
  explorerShell = null
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

  const { shell, base } = await resolveTechnicalBaseArtifact({
    experience,
    sources,
    presentation,
    technicalViews,
    title,
    explorerShell
  });
  const baseSources = sourceBundleFromArtifact(base);
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
  explorerShell
}) {
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
    return { shell, base: projectTechnicalBaseArtifact(compiled) };
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
    return { shell: cached.shell, base: cached.base };
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
  TECHNICAL_BASE_CACHE.set(experience, {
    sources,
    presentation,
    technicalViews,
    title,
    shell,
    base
  });
  return { shell, base };
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
  if (bundle?.schema !== 'kneekura.human-analysis-source-bundle/v1') {
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