import crypto from 'node:crypto';

import {
  compileProductionHumanExperienceArtifact,
  HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
  HUMAN_ARTIFACT_MANIFEST_SCHEMA
} from './artifact-compiler.mjs';
import {
  buildStandaloneHumanExplorerShell,
  injectHumanExperienceOfflinePayload
} from '../human-experience/standalone-explorer.mjs';
import { createDeterministicZip } from './zip.mjs';
import { stableDigest } from './schema.mjs';
import {
  HUMAN_ANALYSIS_TECHNICAL_VIEWS_SCHEMA,
  validateHumanAnalysisTechnicalViews
} from './technical-views-v1.mjs';

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
  const payload = extractOfflinePayload(base.index_html);
  payload.technical_views = structuredClone(technicalViews);
  const indexHtml = injectHumanExperienceOfflinePayload(shell, {
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

function extractOfflinePayload(html) {
  const marker = '<script id="kneekura-human-experience" type="application/octet-stream">';
  const start = html.indexOf(marker);
  if (start < 0) throw new TypeError('production artifact offline payload marker is missing');
  const bodyStart = start + marker.length;
  const end = html.indexOf('</script>', bodyStart);
  if (end < 0) throw new TypeError('production artifact offline payload terminator is missing');
  const encoded = html.slice(bodyStart, end).trim();
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new TypeError('production artifact offline payload encoding is invalid');
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (payload.schema !== 'kneekura.human-experience-offline-payload/v1') {
    throw new TypeError('production artifact offline payload schema is invalid');
  }
  return payload;
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