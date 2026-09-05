import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validateHumanAnalysisIr, stableDigest } from './schema.mjs';
import { createDeterministicZip } from './zip.mjs';
import { assertProductionHumanAnalysisIr } from './production.mjs';
import {
  HUMAN_ANALYSIS_PRESENTATION_SCHEMA,
  validateHumanAnalysisPresentationCompanion
} from './presentation-companion.mjs';
import { validateHumanExperienceProjection } from '../human-experience/schema.mjs';
import {
  buildStandaloneHumanExplorerShell,
  HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA,
  HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA,
  injectHumanExperienceOfflinePayload
} from '../human-experience/standalone-explorer.mjs';

export const HUMAN_ARTIFACT_MANIFEST_SCHEMA = 'kneekura.human-analysis-artifact-manifest/v1';
export const HUMAN_ARTIFACT_REPAIR_ERROR_SCHEMA = 'kneekura.artifact-repair-error/v1';
export const HUMAN_SOURCE_BUNDLE_SCHEMA = 'kneekura.human-analysis-source-bundle/v1';
export const HUMAN_ANALYSIS_ARTIFACT_SCHEMA = 'kneekura.human-analysis-artifact/v1';
export const ARTIFACT_RENDERER_VERSION = 'v1';
export const HUMAN_EXPLORER_ARTIFACT_RENDERER_VERSION = 'human-explorer-v2';

export class ArtifactRepairError extends Error {
  constructor(code, message, { path = null, details = null, repair = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ArtifactRepairError';
    this.schema = HUMAN_ARTIFACT_REPAIR_ERROR_SCHEMA;
    this.code = String(code);
    this.path = path == null ? null : String(path);
    this.details = details == null ? null : structuredClone(details);
    this.repair = repair == null ? null : structuredClone(repair);
  }
  toJSON() {
    return { schema: this.schema, code: this.code, message: this.message, path: this.path, details: this.details, repair: this.repair };
  }
}

export function compileHumanAnalysisArtifact({ ir, sources, title = null } = {}) {
  try {
    validateHumanAnalysisIr(ir);
  } catch (error) {
    throw repair('IR_INVALID', 'Human Analysis IR failed validation', {
      path: 'ir', details: { cause: String(error?.message ?? error) }, repair: { action: 'regenerate_or_revalidate_ir' }, cause: error
    });
  }
  if (ir.generation?.mode === 'PRODUCTION') {
    throw repair(
      'PRODUCTION_EXPLORER_REQUIRED',
      'PRODUCTION Human Analysis IR must be compiled through the full Human Explorer artifact path',
      {
        path: 'ir.generation.mode',
        repair: { action: 'use_compileProductionHumanExperienceArtifact' }
      }
    );
  }
  const sourceBundle = normalizeSourceBundle(ir, sources);
  const normalizedTitle = normalizeTitle(title);
  const analysisJson = stableJson(ir);
  const sourcesJson = stableJson(sourceBundle);
  const coverageJson = stableJson(buildCoverageView(ir));
  const readme = renderReadme(ir, normalizedTitle);
  const htmlModel = buildHtmlModel(ir, sourceBundle, normalizedTitle);
  const indexHtml = renderOfflineHtml(htmlModel);

  const primaryFiles = new Map([
    ['analysis.json', analysisJson], ['coverage.json', coverageJson], ['index.html', indexHtml], ['README.md', readme], ['sources.json', sourcesJson]
  ]);
  const manifestCore = {
    schema: HUMAN_ARTIFACT_MANIFEST_SCHEMA,
    renderer_version: ARTIFACT_RENDERER_VERSION,
    repository: structuredClone(ir.repository),
    ir_digest: ir.ir_digest,
    evidence_pack: structuredClone(ir.evidence_pack),
    title: normalizedTitle,
    security: {
      repository_content_instruction_authority: false,
      source_text_rendering: 'TEXT_CONTENT_ONLY',
      embedded_payload_encoding: 'BASE64_JSON',
      csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
    },
    files: [...primaryFiles.entries()]
      .map(([filePath, content]) => ({ path: filePath, digest: digestBytes(content), bytes: Buffer.byteLength(content) }))
      .sort((a, b) => compareText(a.path, b.path))
  };
  const artifactId = 'artifact:sha256:' + stableDigest(manifestCore).slice('sha256:'.length);
  const manifest = { ...manifestCore, artifact_id: artifactId };
  const manifestJson = stableJson(manifest);
  const files = [...primaryFiles.entries()].map(([filePath, content]) => ({ path: filePath, content }));
  files.push({ path: 'manifest.json', content: manifestJson });
  files.sort((a, b) => compareText(a.path, b.path));

  let zip;
  try {
    zip = createDeterministicZip(files.map(file => ({ path: file.path, data: file.content })));
  } catch (error) {
    throw repair('ZIP_BUILD_FAILED', 'deterministic ZIP companion could not be built', {
      path: 'zip', details: { cause: String(error?.message ?? error) }, repair: { action: 'reduce_or_repair_artifact_files' }, cause: error
    });
  }
  return deepFreeze({
    schema: HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
    artifact_id: artifactId,
    ir_digest: ir.ir_digest,
    manifest,
    files: files.map(file => ({ ...file })),
    index_html: indexHtml,
    zip_bytes: zip,
    zip_digest: digestBytes(zip)
  });
}

export async function compileProductionHumanExperienceArtifact({
  experience,
  sources,
  presentation = null,
  title = null,
  explorerShell = null
} = {}) {
  try {
    validateHumanExperienceProjection(experience);
  } catch (error) {
    throw repair(
      'HUMAN_EXPERIENCE_INVALID',
      'Human Experience projection failed validation',
      {
        path: 'experience',
        details: { cause: String(error?.message ?? error) },
        repair: { action: 'regenerate_or_revalidate_human_experience' },
        cause: error
      }
    );
  }
  const ir = experience.derived?.human_analysis_ir;
  try {
    assertProductionHumanAnalysisIr(ir);
  } catch (error) {
    throw repair(
      'PRODUCTION_IR_REQUIRED',
      'Full Human Explorer artifact requires PRODUCTION Human Analysis IR',
      {
        path: 'experience.derived.human_analysis_ir',
        details: { cause: String(error?.message ?? error) },
        repair: { action: 'run_production_semantic_author' },
        cause: error
      }
    );
  }

  const sourceBundle = normalizeSourceBundle(ir, sources);
  const normalizedPresentation = normalizePresentationForArtifact({
    presentation,
    experience,
    ir,
    sources
  });
  const normalizedTitle = normalizeTitle(title);
  const shell = explorerShell ?? await buildStandaloneHumanExplorerShell();
  if (
    !shell ||
    shell.schema !== HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA ||
    typeof shell.html !== 'string' ||
    !shell.digest?.startsWith('sha256:')
  ) {
    throw repair(
      'HUMAN_EXPLORER_SHELL_INVALID',
      'production artifact requires a validated standalone Human Explorer shell',
      {
        path: 'explorerShell',
        repair: { action: 'rebuild_standalone_human_explorer_shell' }
      }
    );
  }

  const offlinePayload = {
    schema: HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA,
    experience: structuredClone(experience),
    sources: structuredClone(sourceBundle),
    ...(normalizedPresentation
      ? { presentation: structuredClone(normalizedPresentation) }
      : {})
  };
  let indexHtml;
  try {
    indexHtml = injectHumanExperienceOfflinePayload(shell, {
      payload: offlinePayload,
      title: normalizedTitle
    });
  } catch (error) {
    throw repair(
      'HUMAN_EXPLORER_PAYLOAD_INJECTION_FAILED',
      'Human Experience payload could not be injected into the standalone Explorer shell',
      {
        path: 'index.html',
        details: { cause: String(error?.message ?? error) },
        repair: { action: 'rebuild_shell_or_payload' },
        cause: error
      }
    );
  }

  const analysisJson = stableJson(ir);
  const sourcesJson = stableJson(sourceBundle);
  const coverageJson = stableJson(buildCoverageView(ir));
  const experienceJson = stableJson(experience);
  const explorerProjectionJson = stableJson(
    experience.canonical.explorer_projection
  );
  const readme = renderProductionReadme(
    ir,
    normalizedTitle,
    normalizedPresentation?.readiness ?? null
  );

  const primaryFiles = new Map([
    ['analysis.json', analysisJson],
    ['coverage.json', coverageJson],
    ['experience.json', experienceJson],
    ['explorer-projection.json', explorerProjectionJson],
    ['index.html', indexHtml],
    ['README.md', readme],
    ['sources.json', sourcesJson]
  ]);
  if (normalizedPresentation) {
    primaryFiles.set('presentation.json', stableJson(normalizedPresentation));
  }
  const manifestCore = {
    schema: HUMAN_ARTIFACT_MANIFEST_SCHEMA,
    renderer_version: HUMAN_EXPLORER_ARTIFACT_RENDERER_VERSION,
    renderer_surface: 'HUMAN_EXPLORER_V2',
    repository: structuredClone(ir.repository),
    ir_digest: ir.ir_digest,
    evidence_pack: structuredClone(ir.evidence_pack),
    human_experience_projection_id: experience.projection_id,
    human_explorer_shell_digest: shell.digest,
    offline_payload_digest: stableDigest(offlinePayload),
    semantic_readiness: normalizedPresentation
      ? {
          status: normalizedPresentation.readiness.status,
          bounded_preview_ready:
            normalizedPresentation.readiness.bounded_preview_ready,
          repository_scale_ready:
            normalizedPresentation.readiness.repository_scale_ready,
          presentation_id: normalizedPresentation.presentation_id
        }
      : {
          status: 'UNASSESSED',
          bounded_preview_ready: false,
          repository_scale_ready: false,
          presentation_id: null
        },
    title: normalizedTitle,
    security: {
      repository_content_instruction_authority: false,
      source_text_rendering: 'REACT_TEXT_ONLY',
      embedded_payload_encoding: 'BASE64_JSON',
      external_network_required: false,
      csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src blob:"
    },
    files: [...primaryFiles.entries()]
      .map(([filePath, content]) => ({
        path: filePath,
        digest: digestBytes(content),
        bytes: Buffer.byteLength(content)
      }))
      .sort((a, b) => compareText(a.path, b.path))
  };
  const artifactId =
    'artifact:sha256:' +
    stableDigest(manifestCore).slice('sha256:'.length);
  const manifest = {
    ...manifestCore,
    artifact_id: artifactId
  };
  const files = [...primaryFiles.entries()]
    .map(([filePath, content]) => ({ path: filePath, content }));
  files.push({
    path: 'manifest.json',
    content: stableJson(manifest)
  });
  files.sort((a, b) => compareText(a.path, b.path));

  let zip;
  try {
    zip = createDeterministicZip(
      files.map(file => ({
        path: file.path,
        data: file.content
      }))
    );
  } catch (error) {
    throw repair(
      'ZIP_BUILD_FAILED',
      'deterministic Human Explorer ZIP companion could not be built',
      {
        path: 'zip',
        details: { cause: String(error?.message ?? error) },
        repair: { action: 'reduce_or_repair_artifact_files' },
        cause: error
      }
    );
  }

  return deepFreeze({
    schema: HUMAN_ANALYSIS_ARTIFACT_SCHEMA,
    artifact_id: artifactId,
    ir_digest: ir.ir_digest,
    manifest,
    files: files.map(file => ({ ...file })),
    index_html: indexHtml,
    zip_bytes: zip,
    zip_digest: digestBytes(zip)
  });
}

export async function writeHumanAnalysisArtifact({ artifact, outDir, zipFile = 'kneekura-human-guide.zip' } = {}) {
  assertCompiledArtifact(artifact);
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw repair('OUTPUT_DIRECTORY_INVALID', 'outDir is required', { path: 'outDir', repair: { action: 'provide_output_directory' } });
  }
  const root = path.resolve(outDir);
  const zipPath = resolveWithin(root, zipFile, 'zipFile');
  await fs.mkdir(root, { recursive: true });
  for (const file of artifact.files) {
    const target = resolveWithin(root, file.path, `files.${file.path}`);
    await writeAtomic(target, Buffer.from(file.content, 'utf8'));
  }
  await writeAtomic(zipPath, artifact.zip_bytes);
  return deepFreeze({ root, index_path: path.join(root, 'index.html'), zip_path: zipPath, artifact_id: artifact.artifact_id, zip_digest: artifact.zip_digest });
}

function normalizePresentationForArtifact({ presentation, experience, ir, sources }) {
  if (presentation == null) return null;
  if (presentation.schema !== HUMAN_ANALYSIS_PRESENTATION_SCHEMA) {
    throw repair(
      'HUMAN_PRESENTATION_INVALID',
      'production semantic presentation schema is invalid',
      { path: 'presentation' }
    );
  }
  const evidencePack = evidencePackViewFromExperience(experience);
  try {
    validateHumanAnalysisPresentationCompanion(presentation, {
      ir,
      evidencePack,
      sources
    });
  } catch (error) {
    throw repair(
      'HUMAN_PRESENTATION_INVALID',
      'production semantic presentation failed validation',
      {
        path: 'presentation',
        details: { cause: String(error?.message ?? error) },
        repair: { action: 'regenerate_typed_presentation' },
        cause: error
      }
    );
  }
  if (
    presentation.readiness?.status !== 'READY_BOUNDED_PREVIEW' ||
    presentation.readiness?.bounded_preview_ready !== true
  ) {
    throw repair(
      'HUMAN_PRESENTATION_NOT_READY',
      'typed semantic presentation is not ready even for bounded preview delivery',
      {
        path: 'presentation.readiness',
        details: {
          status: presentation.readiness?.status ?? null,
          gaps: presentation.readiness?.gaps ?? []
        },
        repair: { action: 'resolve_semantic_readiness_gaps' }
      }
    );
  }
  return structuredClone(presentation);
}

function evidencePackViewFromExperience(experience) {
  return {
    repository: structuredClone(experience.repository),
    pack_id: experience.source_identity.evidence_pack_id,
    pack_digest: experience.source_identity.evidence_pack_digest,
    canonical_digest: experience.source_identity.canonical_digest,
    source_catalog: structuredClone(experience.source_index?.files ?? []),
    canonical: {
      graph: structuredClone(
        experience.canonical.explorer_projection.canonical.graph
      ),
      result: structuredClone(
        experience.canonical.explorer_projection.canonical.result
      ),
      evidence: structuredClone(experience.canonical.evidence ?? [])
    }
  };
}

function normalizeSourceBundle(ir, sources) {
  if (!Array.isArray(sources)) throw repair('SOURCE_BUNDLE_INVALID', 'sources must be an array', { path: 'sources', repair: { action: 'provide_source_records' } });
  const byKey = new Map();
  for (let index = 0; index < sources.length; index += 1) {
    const normalized = normalizeSourceRecord(sources[index], index);
    const key = sourceKey(normalized.ref);
    if (byKey.has(key)) throw repair('SOURCE_REF_DUPLICATE', `duplicate source ref: ${key}`, { path: `sources[${index}].ref`, details: { source_key: key }, repair: { action: 'deduplicate_source_records' } });
    byKey.set(key, normalized);
  }
  const requiredKeys = new Set();
  for (const item of ir.items) {
    for (const ref of item.source_refs ?? []) {
      const key = sourceKey(ref);
      requiredKeys.add(key);
      if (!byKey.has(key)) throw repair('SOURCE_REF_MISSING', `source ref is not present in source bundle: ${key}`, { path: `items.${item.id}.source_refs`, details: { item_id: item.id, source_key: key }, repair: { action: 'materialize_source_ref' } });
    }
  }
  const records = [...requiredKeys].sort(compareText).map(key => byKey.get(key));
  return deepFreeze({
    schema: HUMAN_SOURCE_BUNDLE_SCHEMA,
    repository: structuredClone(ir.repository),
    ir_digest: ir.ir_digest,
    evidence_pack: structuredClone(ir.evidence_pack),
    records
  });
}

function normalizeSourceRecord(value, index) {
  if (!value || typeof value !== 'object' || !value.ref || typeof value.ref !== 'object') {
    throw repair('SOURCE_RECORD_INVALID', 'source record/ref must be an object', { path: `sources[${index}]`, repair: { action: 'provide_valid_source_record' } });
  }
  if (value.instruction_authority !== false) {
    throw repair('SOURCE_INSTRUCTION_AUTHORITY_VIOLATION', 'source records must have instruction_authority=false', { path: `sources[${index}].instruction_authority`, repair: { action: 'mark_repository_and_evidence_content_as_data' } });
  }
  const ref = canonicalRef(value.ref);
  if (ref.kind === 'FILE_RANGE') {
    const digest = String(value.content_digest ?? ref.content_digest ?? '');
    if (!digest.startsWith('sha256:') || digest !== ref.content_digest) {
      throw repair('SOURCE_DIGEST_MISMATCH', 'FILE_RANGE source digest must match the IR source ref', { path: `sources[${index}].content_digest`, details: { expected: ref.content_digest, actual: digest || null }, repair: { action: 're_read_source_from_snapshot' } });
    }
    if (typeof value.text !== 'string') throw repair('SOURCE_TEXT_MISSING', 'FILE_RANGE source record requires text', { path: `sources[${index}].text`, repair: { action: 'read_exact_source_range' } });
    const trustClass = String(value.trust_class ?? 'UNTRUSTED_REPOSITORY_DATA');
    if (trustClass !== 'UNTRUSTED_REPOSITORY_DATA') throw repair('SOURCE_TRUST_CLASS_INVALID', 'FILE_RANGE source must remain UNTRUSTED_REPOSITORY_DATA', { path: `sources[${index}].trust_class`, repair: { action: 'preserve_source_broker_trust_class' } });
    return deepFreeze({ ref, instruction_authority: false, trust_class: trustClass, content_digest: digest, text_digest: digestBytes(value.text), text: value.text });
  }
  const record = value.record;
  if (!record || typeof record !== 'object' || String(record.id ?? record.ref ?? '') !== ref.id) {
    throw repair('SOURCE_RECORD_MISMATCH', 'canonical source record identity does not match ref', { path: `sources[${index}].record`, details: { expected: ref.id, actual: record?.id ?? record?.ref ?? null }, repair: { action: 'resolve_canonical_ref_again' } });
  }
  const trustClass = String(value.trust_class ?? 'CANONICAL_EVIDENCE_DATA');
  if (trustClass !== 'CANONICAL_EVIDENCE_DATA') throw repair('SOURCE_TRUST_CLASS_INVALID', 'canonical source record must remain CANONICAL_EVIDENCE_DATA', { path: `sources[${index}].trust_class`, repair: { action: 'preserve_source_broker_trust_class' } });
  return deepFreeze({ ref, instruction_authority: false, trust_class: trustClass, record_digest: stableDigest(record), record: structuredClone(record) });
}

function canonicalRef(ref) {
  const kind = String(ref.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    const pathText = normalizeRepoPath(ref.path);
    if (!Number.isInteger(ref.start_line) || ref.start_line < 1 || !Number.isInteger(ref.end_line) || ref.end_line < ref.start_line) {
      throw repair('SOURCE_REF_INVALID', 'FILE_RANGE lines are invalid', { path: 'source_ref', repair: { action: 'fix_source_range' } });
    }
    const digest = String(ref.content_digest ?? '');
    if (!digest.startsWith('sha256:')) throw repair('SOURCE_REF_INVALID', 'FILE_RANGE requires sha256 content_digest', { path: 'source_ref.content_digest', repair: { action: 'attach_snapshot_content_digest' } });
    return { kind, path: pathText, start_line: ref.start_line, end_line: ref.end_line, content_digest: digest };
  }
  if (!['EVIDENCE','CLAIM','COVERAGE','UNKNOWN','NODE','EDGE'].includes(kind) || typeof ref.id !== 'string' || !ref.id) {
    throw repair('SOURCE_REF_INVALID', `unsupported or incomplete source ref: ${kind}`, { path: 'source_ref', repair: { action: 'use_canonical_or_file_range_ref' } });
  }
  return { kind, id: ref.id };
}

function sourceKey(ref) {
  const normalized = canonicalRef(ref);
  return normalized.kind === 'FILE_RANGE'
    ? `FILE_RANGE:${normalized.path}:${normalized.start_line}:${normalized.end_line}:${normalized.content_digest}`
    : `${normalized.kind}:${normalized.id}`;
}

function buildCoverageView(ir) {
  return {
    schema: 'kneekura.human-analysis-artifact-coverage/v1',
    repository: structuredClone(ir.repository), ir_digest: ir.ir_digest,
    coverage_gaps: ir.items.filter(item => item.semantic_class === 'COVERAGE_GAP').map(stripForArtifact),
    unknowns: ir.items.filter(item => item.semantic_class === 'UNKNOWN').map(stripForArtifact)
  };
}

function buildHtmlModel(ir, sourceBundle, title) {
  const sourcesByKey = Object.fromEntries(sourceBundle.records.map(record => [sourceKey(record.ref), record]));
  return {
    schema: 'kneekura.human-analysis-artifact-html-model/v1', title,
    repository: structuredClone(ir.repository), ir_digest: ir.ir_digest,
    evidence_pack: structuredClone(ir.evidence_pack),
    items: ir.items.map(stripForArtifact), stages: structuredClone(ir.stages), review: structuredClone(ir.review), sources_by_key: sourcesByKey
  };
}

function renderOfflineHtml(model) {
  const payload = Buffer.from(stableJson(model), 'utf8').toString('base64');
  const title = escapeHtml(model.title);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">\n<title>${title}</title>\n<style>body{font-family:system-ui,sans-serif;margin:0;background:#f7f7f8;color:#171717}header{padding:18px 24px;background:#fff;border-bottom:1px solid #ddd}main{max-width:1100px;margin:auto;padding:24px}.toolbar{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 20px}.toolbar input,.toolbar select{padding:8px 10px}.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0}.meta,.refs{font-size:12px;color:#555}.tag{display:inline-block;border:1px solid #bbb;border-radius:999px;padding:2px 8px;margin-right:6px;font-size:12px}.source{white-space:pre-wrap;background:#111;color:#eee;padding:12px;border-radius:8px;overflow:auto}</style>\n</head>\n<body>\n<header><h1>${title}</h1><div id="identity"></div></header>\n<main><div class="toolbar"><input id="q" placeholder="Search"><select id="klass"><option value="">All classes</option><option>AI_INTERPRETATION</option><option>UNKNOWN</option><option>COVERAGE_GAP</option></select></div><div id="summary"></div><div id="items"></div></main>\n<script id="kneekura-data" type="application/octet-stream">${payload}</script>\n<script>"use strict";const raw=document.getElementById("kneekura-data").textContent.trim();const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw),c=>c.charCodeAt(0))));const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=String(text);if(cls)n.className=cls;return n};document.getElementById("identity").textContent=data.repository.repository_id+" · "+data.repository.snapshot_id;const items=document.getElementById("items"),q=document.getElementById("q"),klass=document.getElementById("klass");document.getElementById("summary").textContent=data.items.length+" derived items · IR "+data.ir_digest;function render(){items.replaceChildren();const query=q.value.toLowerCase(),k=klass.value;for(const item of data.items){if(k&&item.semantic_class!==k)continue;const hay=(item.title+" "+item.body).toLowerCase();if(query&&!hay.includes(query))continue;const card=el("article",null,"card"),h=el("h2",item.title),tags=el("div",null,"meta");tags.append(el("span",item.stage,"tag"),el("span",item.semantic_class,"tag"),el("span",item.review_status,"tag"));card.append(h,tags,el("p",item.body));card.append(el("div","Sources: "+item.source_refs.map(r=>r.kind==="FILE_RANGE"?r.path+":"+r.start_line+"-"+r.end_line:r.kind+":"+r.id).join(", "),"refs"));for(const ref of item.source_refs){const key=ref.kind==="FILE_RANGE"?"FILE_RANGE:"+ref.path+":"+ref.start_line+":"+ref.end_line+":"+ref.content_digest:ref.kind+":"+ref.id;const source=data.sources_by_key[key];if(source&&typeof source.text==="string"){const details=document.createElement("details");details.append(el("summary","Show source"),el("pre",source.text,"source"));card.append(details)}}items.append(card)}}q.addEventListener("input",render);klass.addEventListener("change",render);render();</script>\n</body>\n</html>\n`;
}

function renderProductionReadme(ir, title, readiness = null) {
  return `# ${title}\n\nPortable KNEEKURA Human Explorer production artifact.\n\n- IR: ${ir.ir_digest}\n- Repository: ${ir.repository.repository_id}\n- Snapshot: ${ir.repository.snapshot_id}\n- Renderer: HUMAN_EXPLORER_V2\n- Semantic readiness: ${readiness?.status ?? 'UNASSESSED'}\n- Repository-scale ready: ${readiness?.repository_scale_ready === true ? 'yes' : 'no'}\n- The full ReactFlow/ELK Human Explorer is bundled into index.html.\n- Repository/source text remains inert data and never gains instruction authority.\n- Open index.html directly in a browser; no server or network connection is required.\n`;
}

function renderReadme(ir, title) {
  return `# ${title}\n\nPortable KNEEKURA Human Analysis artifact.\n\n- IR: ${ir.ir_digest}\n- Repository: ${ir.repository.repository_id}\n- Snapshot: ${ir.repository.snapshot_id}\n- Derived semantic content is AI_INTERPRETATION / UNKNOWN / COVERAGE_GAP only.\n- Repository/source text is data, not instruction authority.\n- Open index.html directly in a browser; no server or package install is required.\n`;
}

function stripForArtifact(item) {
  return {
    id:item.id, stage:item.stage, kind:item.kind, semantic_class:item.semantic_class, origin:item.origin, authority_level:item.authority_level,
    title:item.title, body:item.body, source_refs:structuredClone(item.source_refs), confidence:structuredClone(item.confidence),
    ordering_key:item.ordering_key, review_status:item.review_status, review_reason:item.review_reason, metadata:structuredClone(item.metadata)
  };
}

function normalizeTitle(title) {
  const value = String(title ?? 'KNEEKURA Human Analysis').trim();
  if (!value) throw repair('TITLE_INVALID', 'artifact title must not be empty', { path:'title', repair:{ action:'provide_nonempty_title' } });
  return value.slice(0, 200);
}

function normalizeRepoPath(value) {
  const text = String(value ?? '').replaceAll('\\','/').replace(/^\.\//,'');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.split('/').includes('..')) throw repair('SOURCE_REF_INVALID', `unsafe repository path: ${value}`, { path:'source_ref.path', repair:{ action:'use_repository_relative_path' } });
  return text;
}

function resolveWithin(root, relative, field) {
  const normalized = String(relative ?? '').replaceAll('\\','/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) throw repair('OUTPUT_PATH_ESCAPE', `${field} must stay inside artifact root`, { path:field, repair:{ action:'use_relative_output_path' } });
  const target = path.resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) throw repair('OUTPUT_PATH_ESCAPE', `${field} escaped artifact root`, { path:field });
  if (target === root) throw repair('OUTPUT_PATH_ESCAPE', `${field} must resolve below artifact root`, { path:field });
  return target;
}

function assertCompiledArtifact(artifact) {
  if (!artifact || artifact.schema !== HUMAN_ANALYSIS_ARTIFACT_SCHEMA || !Array.isArray(artifact.files) || !Buffer.isBuffer(artifact.zip_bytes)) {
    throw repair('ARTIFACT_INVALID', 'write requires compiled artifact', { path:'artifact', repair:{ action:'compile_artifact_first' } });
  }
  if (!artifact.manifest || artifact.manifest.schema !== HUMAN_ARTIFACT_MANIFEST_SCHEMA || artifact.manifest.artifact_id !== artifact.artifact_id) {
    throw repair('ARTIFACT_MANIFEST_INVALID', 'artifact manifest identity is invalid', { path:'artifact.manifest', repair:{ action:'recompile_artifact' } });
  }
  const manifestCore = structuredClone(artifact.manifest);
  delete manifestCore.artifact_id;
  const expectedArtifactId = 'artifact:sha256:' + stableDigest(manifestCore).slice('sha256:'.length);
  if (expectedArtifactId !== artifact.artifact_id) throw repair('ARTIFACT_DIGEST_MISMATCH', 'artifact_id does not match manifest', { path:'artifact.artifact_id', details:{ expected:expectedArtifactId, actual:artifact.artifact_id }, repair:{ action:'recompile_artifact' } });

  const fileByPath = new Map(artifact.files.map(file => [file.path, file]));
  if (fileByPath.size !== artifact.files.length) throw repair('ARTIFACT_FILE_DUPLICATE', 'artifact file paths must be unique', { path:'artifact.files', repair:{ action:'recompile_artifact' } });
  for (const meta of artifact.manifest.files ?? []) {
    const file = fileByPath.get(meta.path);
    if (!file || typeof file.content !== 'string') throw repair('ARTIFACT_FILE_MISSING', `artifact file missing: ${meta.path}`, { path:`artifact.files.${meta.path}`, repair:{ action:'recompile_artifact' } });
    const actualDigest = digestBytes(file.content);
    const actualBytes = Buffer.byteLength(file.content);
    if (actualDigest !== meta.digest || actualBytes !== meta.bytes) throw repair('ARTIFACT_FILE_DIGEST_MISMATCH', `artifact file digest mismatch: ${meta.path}`, { path:`artifact.files.${meta.path}`, details:{ expected_digest:meta.digest, actual_digest:actualDigest, expected_bytes:meta.bytes, actual_bytes:actualBytes }, repair:{ action:'recompile_artifact' } });
  }
  const manifestFile = fileByPath.get('manifest.json');
  if (!manifestFile || manifestFile.content !== stableJson(artifact.manifest)) throw repair('ARTIFACT_MANIFEST_MISMATCH', 'manifest.json does not match artifact.manifest', { path:'artifact.files.manifest.json', repair:{ action:'recompile_artifact' } });
  const rebuiltZip = createDeterministicZip(artifact.files.map(file => ({ path:file.path, data:file.content })));
  if (!artifact.zip_bytes.equals(rebuiltZip) || artifact.zip_digest !== digestBytes(rebuiltZip)) throw repair('ARTIFACT_ZIP_DIGEST_MISMATCH', 'ZIP companion does not match artifact files', { path:'artifact.zip_bytes', repair:{ action:'recompile_artifact' } });
}

async function writeAtomic(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive:true });
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, filePath);
}

function stableJson(value) { return JSON.stringify(sortObject(value), null, 2) + '\n'; }
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])]));
  return value;
}
function digestBytes(value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }
function escapeHtml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
function repair(code, message, options={}) { return new ArtifactRepairError(code, message, options); }
function compareText(a,b) { const left=String(a), right=String(b); return left < right ? -1 : left > right ? 1 : 0; }