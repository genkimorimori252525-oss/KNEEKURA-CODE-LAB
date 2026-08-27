export async function loadViewerSources({
  fetchImpl = globalThis.fetch,
  manifestUrl = '/viewer-manifest.json',
  resultUrl = '/analysis-result.json',
  graphUrl = '/graph.json'
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('viewer loader requires fetch');
  }

  const manifest = await tryFetchJson(fetchImpl, manifestUrl);
  let result = null;
  let graphTarget = graphUrl;

  if (manifest) {
    if (manifest.schema !== 'core.human-viewer-manifest/v1') {
      throw new Error(
        'unsupported viewer manifest schema: ' + manifest.schema
      );
    }
    const resultTarget = resolveRef(
      manifest.result_ref ?? resultUrl,
      manifestUrl
    );
    graphTarget = resolveRef(
      manifest.graph_ref ?? graphUrl,
      manifestUrl
    );
    result = await requireFetchJson(fetchImpl, resultTarget);
    assertAnalysisResult(result);
  } else {
    result = await tryFetchJson(fetchImpl, resultUrl);
    if (result) assertAnalysisResult(result);
  }

  const graph = await requireFetchJson(fetchImpl, graphTarget);
  assertGraph(graph);

  const inlineEvidence = new Map(
    (result?.evidence ?? []).map(record => [record.id, record])
  );
  const evidenceCache = new Map();

  return {
    graph,
    result,
    manifest,
    mode: result
      ? (manifest ? 'VIEWER_BUNDLE' : 'ANALYSIS_RESULT')
      : 'GRAPH_ONLY',

    async loadEvidence(evidenceId) {
      const id = String(evidenceId);
      if (evidenceCache.has(id)) {
        return structuredClone(evidenceCache.get(id));
      }
      if (inlineEvidence.has(id)) {
        const value = structuredClone(inlineEvidence.get(id));
        evidenceCache.set(id, value);
        return structuredClone(value);
      }

      const entry = manifest?.evidence_index?.[id];
      if (!entry?.ref) return null;
      const target = resolveRef(entry.ref, manifestUrl);
      const value = await requireFetchJson(fetchImpl, target);
      if (value?.schema !== 'core.evidence/v1') {
        throw new Error(
          'evidence ref must use core.evidence/v1'
        );
      }
      if (value?.id !== id) {
        throw new Error(
          'evidence ref identity mismatch: expected ' +
          id + ', got ' + String(value?.id)
        );
      }
      evidenceCache.set(id, value);
      return structuredClone(value);
    }
  };
}

async function tryFetchJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      'viewer fetch failed ' + response.status + ': ' + url
    );
  }
  return response.json();
}

async function requireFetchJson(fetchImpl, url) {
  const value = await tryFetchJson(fetchImpl, url);
  if (value == null) {
    throw new Error('viewer resource not found: ' + url);
  }
  return value;
}

function resolveRef(ref, base) {
  let value;
  try {
    value = decodeURIComponent(String(ref));
  } catch {
    throw new Error('Viewer ref contains invalid percent encoding');
  }
  value = normalizeSeparators(value);

  if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.startsWith('//')
  ) {
    throw new Error('external Viewer refs are forbidden');
  }
  if (value.split('/').includes('..')) {
    throw new Error('Viewer ref may not escape its bundle');
  }
  if (value.startsWith('/')) {
    return value;
  }

  const baseValue = normalizeSeparators(base);
  const slash = baseValue.lastIndexOf('/');
  if (slash < 0) return value.replace(/^\.\//, '');
  return (
    baseValue.slice(0, slash + 1) +
    value.replace(/^\.\//, '')
  );
}

function normalizeSeparators(value) {
  return String(value)
    .split(String.fromCharCode(92))
    .join('/');
}

function assertAnalysisResult(result) {
  if (result?.schema !== 'core.analysis-result/v1') {
    throw new Error(
      'viewer result must use core.analysis-result/v1'
    );
  }
}

function assertGraph(graph) {
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error('viewer graph requires nodes/edges arrays');
  }
}
