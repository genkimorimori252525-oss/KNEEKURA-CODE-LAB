import {
  analyzeInternal,
  CORE_ENGINE_FINGERPRINT
} from './analyze.mjs';
import { expandAnalysis } from './expand.mjs';
import { getAnalysisRef } from './get.mjs';

export function createCoreEngine(options = {}) {
  const analyses = new Map();
  const refs = new Map();

  return Object.freeze({
    async analyze(request, perCallOptions = {}) {
      const execution = await analyzeInternal(request, {
        ...options,
        ...perCallOptions,
        scan: {
          ...(options.scan ?? {}),
          ...(perCallOptions.scan ?? {})
        },
        planning: {
          ...(options.planning ?? {}),
          ...(perCallOptions.planning ?? {})
        },
        verificationContext: {
          ...(options.verificationContext ?? {}),
          ...(perCallOptions.verificationContext ?? {})
        }
      });
      execution.state.engine_fingerprint = CORE_ENGINE_FINGERPRINT;
      execution.state.expansion_planning_options = {
        ...(options.planning ?? {}),
        ...(perCallOptions.planning ?? {})
      };
      execution.state.result = execution.result;
      analyses.set(execution.result.analysis_id, execution.state);
      indexState(refs, execution.state);
      return structuredClone(execution.result);
    },

    async expand(analysisId, target, budget = {}) {
      const state = analyses.get(String(analysisId));
      if (!state) throw new Error('analysis not found: ' + analysisId);
      const delta = await expandAnalysis(state, target, budget);
      indexState(refs, state);
      return structuredClone(delta);
    },

    get(ref) {
      const key = typeof ref === 'string' ? ref : ref?.ref ?? ref?.id;
      if (typeof key !== 'string' || !key) {
        throw new TypeError('stable ref is required');
      }

      const indexed = refs.get(key) ?? [];
      if (indexed.length === 1) {
        return structuredClone(indexed[0].value);
      }
      if (indexed.length > 1) {
        const first = JSON.stringify(indexed[0].value);
        if (indexed.every(item => JSON.stringify(item.value) === first)) {
          return structuredClone(indexed[0].value);
        }
        throw new Error(
          'stable ref is ambiguous across retained analyses: ' + key
        );
      }

      for (const state of analyses.values()) {
        const found = getAnalysisRef(state, key);
        if (found) return structuredClone(found.value);
      }
      return null;
    },

    hasAnalysis(analysisId) {
      return analyses.has(String(analysisId));
    },

    analysisIds() {
      return [...analyses.keys()].sort();
    }
  });
}

function indexState(index, state) {
  for (const claim of state.ledger?.claims ?? []) {
    addIndex(index, claim.id, 'CLAIM', claim);
  }
  for (const evidence of state.ledger?.evidence ?? []) {
    addIndex(index, evidence.id, 'EVIDENCE', evidence);
    const provenance = evidence.provenance ?? {};
    for (const ref of [
      provenance.artifact_id,
      provenance.artifact_digest,
      provenance.runtime_run_id
    ].filter(Boolean)) {
      addIndex(index, String(ref), 'ARTIFACT', {
        ref: String(ref),
        evidence_id: evidence.id,
        provenance: structuredClone(provenance),
        evidence_kind: evidence.kind
      });
    }
  }
  for (const node of state.graph?.nodes ?? []) {
    addIndex(index, node.id, 'GRAPH_NODE', node);
  }
}

function addIndex(index, key, kind, value) {
  if (!index.has(key)) index.set(key, []);
  const rows = index.get(key);
  const serialized = JSON.stringify(value);
  if (!rows.some(item =>
    item.kind === kind && JSON.stringify(item.value) === serialized
  )) {
    rows.push({
      kind,
      value: structuredClone(value)
    });
  }
}
