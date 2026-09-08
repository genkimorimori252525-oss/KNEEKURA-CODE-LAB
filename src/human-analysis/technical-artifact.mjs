import crypto from 'node:crypto';

import {
  compileProductionHumanExperienceArtifact,
  HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
  HUMAN_ARTIFACT_MANIFEST_SCHEMA
} from './artifact-compiler.mjs';
import {
  buildStandaloneHumanExplorerShell,
  injectHumanExperienceOfflinePayloadStreaming
} from '../human-experience/standalone-explorer.mjs';
import { createDeterministicZip } from './zip.mjs';
import { stableDigest } from './schema.mjs';
import {
  HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA,
  validateHumanAnalysisTechnicalViews
} from './technical-views-v1.mjs';

const OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';

export async function compileProductionHumanExperienceArtifactWithTechnicalViews({
  experience,
  sources,
  presentation,
  technicalViews,
  title = null,
  explorerShell = null
} = {}) {
  const ir = experience?.derived?.human_analysis_ir;
  validateHumanAnalysisTechnicalViews(technicalViews, { ir, presentation });
  const shell = explorerShell ?? await buildStandaloneHumanExplorerShell();
  const base = await compileProductionHumanExperienceArtifact({
    experience,
    sources,
    presentation,
    title,
    explorerShell: shell
  });
  const payload = {
    schema: OFFLINE_PAYLOAD_SCHEMA,
    experience,
    sources: sourceBundleFromArtifact(base),
    ...(presentation == null ? {} : { presentation }),
    technical_views: technicalViews
  };
  const indexHtml = await injectHumanExperienceOfflinePayloadStreaming(shell, {
    payload,
    title: base.manifest.title
  });

  const primary = new Map(
    base.files
      .filter(file => file.path !== 'manifest.json')
      .map(file => [file.path, file.content])
  );
  primary.set('index.html', indexHtml);
  primary.set('technical-views.json', stableJson(technicalViews));

  const manifestCore = structuredClone(base.manifest);
  delete manifestCore.artifact_id;
  delete manifestCore.files;
  manifestCore.offline_payload_digest = stableDigest(payload);
  manifestCore.security = {
    ...manifestCore.security,
    embedded_payload_encoding: 'BASE64_GZIP_JSON_ENVELOPE'
  };
  manifestCore.technical_views = {
    schema: HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA,
    view_set_id: technicalViews.view_set_id
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
    ir_digest: ir.ir_digest,
    manifest,
    files,
    index_html: indexHtml,
    zip_bytes: zip,
    zip_digest: digestBytes(zip)
  });
}

function sourceBundleFromArtifact(artifact) {
  const sourceFile = artifact.files.find(file => file.path === 'sources.json');
  if (!sourceFile || typeof sourceFile.content !== 'string') {
    throw new TypeError('production artifact normalized source bundle is missing');
  }
  const bundle = JSON.parse(sourceFile.content);
  if (bundle?.schema !== 'kneekura.human-analysis-source-bundle/v1') {
    throw new TypeError('production artifact normalized source bundle schema is invalid');
  }
  return bundle;
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