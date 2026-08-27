import {
  validateAnalysisResultV1
} from '../schema/v1.mjs';
import {
  buildHumanDiagramProjection
} from './human-projection.mjs';

export const VIEWER_MANIFEST_SCHEMA =
  'core.viewer-analysis-manifest/v1';
export const VIEWER_REF_SCHEMA =
  'core.viewer-ref/v1';

export function createViewerAnalysisManifest(result) {
  validateAnalysisResultV1(result);
  const lightweight = structuredClone(result);
  delete lightweight.evidence;
  delete lightweight.verifier_records;

  return {
    schema: VIEWER_MANIFEST_SCHEMA,
    analysis_result: lightweight,
    lazy: {
      ref_endpoint: '/api/ref',
      diagram_endpoint: '/api/diagram',
      evidence_count: result.evidence?.length ?? 0,
      verifier_record_count:
        result.verifier_records?.length ?? 0
    }
  };
}

export function createViewerDiagram(
  result,
  graph,
  options = {}
) {
  validateAnalysisResultV1(result);
  return buildHumanDiagramProjection(
    result,
    graph,
    options
  );
}

export function resolveViewerRef(result, graph, ref) {
  validateAnalysisResultV1(result);
  assertGraph(graph);
  const key = String(ref ?? '').trim();
  if (!key) throw new TypeError('viewer ref is required');

  const claim = (result.claims ?? [])
    .find(item => item.id === key);
  if (claim) {
    return wrapRef('CLAIM', key, claim);
  }

  const evidence = (result.evidence ?? [])
    .find(item => item.id === key);
  if (evidence) {
    return wrapRef('EVIDENCE', key, evidence);
  }

  const verifier = (result.verifier_records ?? [])
    .find(item => item.id === key);
  if (verifier) {
    return wrapRef('VERIFICATION_RECORD', key, verifier);
  }

  const graphRef = normalizeGraphRef(key);
  if (graphRef.kind === 'NODE') {
    const node = graph.nodes.find(
      item => item.id === graphRef.id
    );
    if (node) {
      return wrapRef(
        'GRAPH_NODE',
        'graph-node:' + node.id,
        node
      );
    }
  }
  if (graphRef.kind === 'EDGE') {
    const edge = graph.edges.find(
      item => item.id === graphRef.id
    );
    if (edge) {
      return wrapRef(
        'GRAPH_EDGE',
        'graph-edge:' + edge.id,
        edge
      );
    }
  }

  const artifactEvidence = (result.evidence ?? [])
    .find(item => {
      const provenance = item.provenance ?? {};
      return [
        provenance.artifact_id,
        provenance.artifact_digest,
        provenance.runtime_run_id,
        provenance.git_object_id
      ].filter(Boolean).some(value =>
        String(value) === key
      );
    });
  if (artifactEvidence) {
    return wrapRef('ARTIFACT', key, {
      ref: key,
      evidence_id: artifactEvidence.id,
      kind: artifactEvidence.kind,
      provenance: structuredClone(
        artifactEvidence.provenance
      )
    });
  }

  return null;
}

function wrapRef(kind, ref, value) {
  return {
    schema: VIEWER_REF_SCHEMA,
    kind,
    ref,
    value: structuredClone(value)
  };
}

function normalizeGraphRef(value) {
  if (value.startsWith('graph-node:')) {
    return {
      kind: 'NODE',
      id: value.slice('graph-node:'.length)
    };
  }
  if (value.startsWith('graph-edge:')) {
    return {
      kind: 'EDGE',
      id: value.slice('graph-edge:'.length)
    };
  }
  return {
    kind: 'NODE',
    id: value
  };
}

function assertGraph(graph) {
  if (
    !graph ||
    graph.schema !== 'kneekura.graph/v1' ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new TypeError('kneekura.graph/v1 is required');
  }
}
