import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  validateAnalysisResultV1,
  validateEvidenceRecordV1
} from '../core/schema/v1.mjs';

export const HUMAN_VIEWER_MANIFEST_SCHEMA =
  'core.human-viewer-manifest/v1';

export function createHumanViewerManifest(result, {
  resultRef = 'analysis-result.json',
  graphRef = 'graph.json',
  evidenceBase = 'refs/evidence'
} = {}) {
  validateAnalysisResultV1(result);

  const lightweightResult = structuredClone(result);
  delete lightweightResult.evidence;
  validateAnalysisResultV1(lightweightResult);

  const evidenceIndex = {};
  for (const record of (result.evidence ?? []).slice().sort(compareEvidence)) {
    validateEvidenceRecordV1(record);
    const ref = joinWebPath(
      evidenceBase,
      encodeRef(record.id) + '.json'
    );
    evidenceIndex[record.id] = {
      id: record.id,
      kind: record.kind,
      trust_class: record.trust_class,
      provider_id: record.provider_id,
      provider_version: record.provider_version,
      provenance: compactProvenance(record.provenance),
      ref
    };
  }

  const manifest = {
    schema: HUMAN_VIEWER_MANIFEST_SCHEMA,
    source_schema: result.schema,
    analysis_id: result.analysis_id,
    session_id: result.session_id,
    snapshot_id: result.snapshot.snapshot_id,
    result_ref: resultRef,
    graph_ref: graphRef,
    evidence_index: evidenceIndex,
    counts: {
      claims: result.claims?.length ?? 0,
      evidence: result.evidence?.length ?? 0,
      coverage_entries: result.coverage?.entries?.length ?? 0,
      unknowns: result.unknowns?.length ?? 0
    },
    source_result_digest: digestObject(result)
  };

  return {
    manifest,
    result: lightweightResult
  };
}

export async function writeHumanViewerBundle({
  result,
  graph,
  outDir,
  resultFile = 'analysis-result.json',
  graphFile = 'graph.json',
  manifestFile = 'viewer-manifest.json',
  evidenceBase = 'refs/evidence'
}) {
  if (!outDir || typeof outDir !== 'string') {
    throw new TypeError('outDir is required');
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('viewer bundle requires graph nodes/edges');
  }

  const root = path.resolve(outDir);
  const resultPath = resolveWithinBundle(root, resultFile, 'resultFile');
  const graphPath = resolveWithinBundle(root, graphFile, 'graphFile');
  const manifestPath = resolveWithinBundle(root, manifestFile, 'manifestFile');
  const evidenceDir = resolveWithinBundle(root, evidenceBase, 'evidenceBase');

  const bundle = createHumanViewerManifest(result, {
    resultRef: resultFile,
    graphRef: graphFile,
    evidenceBase
  });

  await fs.mkdir(evidenceDir, { recursive: true });
  await writeJsonAtomic(resultPath, bundle.result);
  await writeJsonAtomic(graphPath, graph);
  await writeJsonAtomic(manifestPath, bundle.manifest);

  for (const record of result.evidence ?? []) {
    validateEvidenceRecordV1(record);
    await writeJsonAtomic(
      path.join(evidenceDir, encodeRef(record.id) + '.json'),
      record
    );
  }

  return {
    root,
    manifest_path: manifestPath,
    result_path: resultPath,
    graph_path: graphPath,
    evidence_count: result.evidence?.length ?? 0,
    manifest: bundle.manifest
  };
}

export function encodeRef(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function resolveWithinBundle(root, relativePath, name) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new TypeError(name + ' must be a non-empty relative path');
  }
  const normalized = normalizeSeparators(relativePath);
  if (
    path.isAbsolute(relativePath) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error(name + ' must stay inside the Viewer bundle');
  }
  const target = path.resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(name + ' must stay inside the Viewer bundle');
  }
  if (target === root) {
    throw new Error(name + ' must resolve to a file or subdirectory');
  }
  return target;
}

function normalizeSeparators(value) {
  return String(value)
    .split(String.fromCharCode(92))
    .join('/');
}

function compactProvenance(provenance = {}) {
  return {
    repository_id: provenance.repository_id ?? null,
    snapshot_id: provenance.snapshot_id ?? null,
    provider_id: provenance.provider_id ?? null,
    provider_version: provenance.provider_version ?? null,
    extraction_method: provenance.extraction_method ?? null,
    ...(provenance.path ? { path: provenance.path } : {}),
    ...(provenance.range ? {
      range: structuredClone(provenance.range)
    } : {}),
    ...(provenance.symbol_id ? {
      symbol_id: provenance.symbol_id
    } : {}),
    ...(provenance.artifact_id ? {
      artifact_id: provenance.artifact_id
    } : {}),
    ...(provenance.artifact_digest ? {
      artifact_digest: provenance.artifact_digest
    } : {}),
    ...(provenance.runtime_run_id ? {
      runtime_run_id: provenance.runtime_run_id
    } : {})
  };
}

function compareEvidence(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function joinWebPath(...parts) {
  return parts
    .flatMap(part => String(part).split('/'))
    .filter(Boolean)
    .join('/');
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp =
    file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  await fs.writeFile(
    temp,
    JSON.stringify(value, null, 2) + '\n',
    'utf8'
  );
  await fs.rename(temp, file);
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
