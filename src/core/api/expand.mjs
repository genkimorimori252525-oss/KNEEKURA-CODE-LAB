import crypto from 'node:crypto';
import { planDeterministicAnalysis } from '../planning.mjs';

export const ANALYSIS_DELTA_SCHEMA = 'core.analysis-delta/v1';

export async function expandAnalysis(state, target, budget = {}) {
  assertState(state);
  const seed = expansionSeed(state, target);
  const request = structuredClone(state.request);
  request.seeds = [
    ...(request.seeds ?? []),
    seed
  ];
  request.budget = {
    ...(request.budget ?? {}),
    ...structuredClone(budget ?? {})
  };

  const previousPlanning = state.planning;
  const nextPlanning = planDeterministicAnalysis(
    state.graph,
    request,
    state.expansion_planning_options ?? {}
  );

  const previousIds = new Set(previousPlanning.scope.selected_ids ?? []);
  const nextIds = new Set(nextPlanning.scope.selected_ids ?? []);
  const addedScopeIds = [...nextIds]
    .filter(id => !previousIds.has(id))
    .sort();
  const retainedScopeIds = [...nextIds]
    .filter(id => previousIds.has(id))
    .sort();

  const selectedNodeIds = new Set(
    nextPlanning.scope.items
      .filter(item => item.selected !== false && item.node_id)
      .map(item => item.node_id)
  );
  const graphPaths = state.graph.edges
    .filter(edge =>
      selectedNodeIds.has(edge.from) || selectedNodeIds.has(edge.to)
    )
    .map(edge => ({
      edge_id: edge.id,
      edge_type: edge.type,
      from: edge.from,
      to: edge.to,
      confidence: edge.confidence ?? 1
    }))
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));

  const evidenceRefs = state.ledger.evidence
    .filter(record => evidenceTouchesScope(record, nextPlanning.scope))
    .map(record => record.id)
    .sort();

  const childSessionId = state.session_store
    ? 'session:' + crypto.randomUUID()
    : 'session:expand:sha256:' + crypto.createHash('sha256')
      .update([
        state.analysis_id,
        state.session_id,
        stableStringify(seed),
        stableStringify(request.budget ?? {})
      ].join('\0'))
      .digest('hex');

  if (state.session_store) {
    await state.session_store.startSession({
      sessionId: childSessionId,
      parentSessionId: state.session_id,
      targetSnapshotId: state.graph.meta.snapshot.snapshot_id,
      normalizedRequest: request,
      engineFingerprint: state.engine_fingerprint,
      ruleFingerprints: [nextPlanning.rules.resolution_fingerprint],
      reusedEvidenceIds: state.ledger.evidence.map(item => item.id)
    });
    await state.session_store.append(childSessionId, 'SNAPSHOT_FROZEN', {
      snapshot: state.graph.meta.snapshot
    });
    for (const decision of nextPlanning.scope.decisions) {
      await state.session_store.append(childSessionId, 'SCOPE_DECISION', {
        decision
      });
    }
    await state.session_store.append(childSessionId, 'COVERAGE_CHANGED', {
      coverage: nextPlanning.coverage
    });
    await state.session_store.append(childSessionId, 'METRICS_UPDATED', {
      metrics: {
        coverage_expansion_count: 1
      }
    });
    await state.session_store.append(childSessionId, 'SESSION_FINALIZED', {
      coverage: nextPlanning.coverage,
      claims: state.ledger.claims
    });
    await state.session_store.writeMaterializedState(childSessionId);
  }

  state.planning = nextPlanning;
  state.current_coverage = structuredClone(nextPlanning.coverage);
  state.last_expansion_session_id = childSessionId;

  return {
    schema: ANALYSIS_DELTA_SCHEMA,
    analysis_id: state.analysis_id,
    parent_session_id: state.session_id,
    session_id: childSessionId,
    snapshot_id: state.graph.meta.snapshot.snapshot_id,
    target: structuredClone(target),
    resolved_seed: seed,
    added_scope_ids: addedScopeIds,
    retained_scope_ids: retainedScopeIds,
    coverage: structuredClone(nextPlanning.coverage),
    graph_paths: graphPaths,
    evidence_refs: evidenceRefs,
    affected_symbols: state.graph.nodes
      .filter(node => selectedNodeIds.has(node.id))
      .map(node => ({
        node_id: node.id,
        kind: node.kind,
        key: node.key ?? null,
        label: node.label ?? null,
        ...(node.path ? { path: node.path } : {})
      }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id))
  };
}

function expansionSeed(state, target) {
  if (typeof target === 'string') {
    if (state.graph.nodes.some(node => node.id === target)) {
      return { kind: 'GRAPH_NODE', value: target };
    }
    const claim = state.ledger.claims.find(item => item.id === target);
    if (claim) return seedForClaim(claim);
    const evidence = state.ledger.evidence.find(item => item.id === target);
    if (evidence) return seedForEvidence(evidence);
    return { kind: 'SYMBOL', value: target };
  }

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('expand target must be a string or object');
  }

  const kind = String(target.kind ?? '').toUpperCase()
    .replaceAll('-', '_');
  const ref = target.ref ?? target.id ?? target.value;
  if (ref == null) throw new TypeError('expand target ref is required');

  if (kind === 'CLAIM') {
    const claim = state.ledger.claims.find(item => item.id === String(ref));
    if (!claim) throw new Error('expand Claim not found: ' + ref);
    return seedForClaim(claim);
  }
  if (kind === 'EVIDENCE') {
    const evidence = state.ledger.evidence.find(item => item.id === String(ref));
    if (!evidence) throw new Error('expand Evidence not found: ' + ref);
    return seedForEvidence(evidence);
  }
  if (kind === 'GRAPH_NODE' || kind === 'NODE') {
    return { kind: 'GRAPH_NODE', value: String(ref) };
  }
  if (kind === 'PATH') return { kind: 'PATH', value: String(ref) };
  if (kind === 'SYMBOL') return { kind: 'SYMBOL', value: String(ref) };
  if (kind === 'RUNTIME_REF' || kind === 'ARTIFACT') {
    return { kind: 'RUNTIME_REF', value: String(ref) };
  }

  throw new TypeError('unsupported expand target kind: ' + kind);
}

function seedForClaim(claim) {
  if (claim.subject?.node_id) {
    return { kind: 'GRAPH_NODE', value: claim.subject.node_id };
  }
  if (claim.subject?.key) {
    return { kind: 'SYMBOL', value: claim.subject.key };
  }
  throw new Error('Claim has no expandable graph subject: ' + claim.id);
}

function seedForEvidence(evidence) {
  const provenance = evidence.provenance ?? {};
  if (provenance.symbol_id) {
    return { kind: 'SYMBOL', value: provenance.symbol_id };
  }
  if (provenance.path) {
    return { kind: 'PATH', value: provenance.path };
  }
  if (provenance.artifact_id) {
    return { kind: 'RUNTIME_REF', value: provenance.artifact_id };
  }
  if (provenance.runtime_run_id) {
    return { kind: 'RUNTIME_REF', value: provenance.runtime_run_id };
  }
  throw new Error('Evidence has no expandable anchor: ' + evidence.id);
}

function evidenceTouchesScope(record, scope) {
  const selectedEvidence = new Set(
    scope.items
      .filter(item => item.selected !== false && item.evidence_id)
      .map(item => item.evidence_id)
  );
  if (selectedEvidence.has(record.id)) return true;

  const selectedPaths = new Set(
    scope.items
      .filter(item => item.selected !== false && item.path)
      .map(item => normalizePath(item.path))
  );
  const path = normalizePath(record.provenance?.path);
  return Boolean(path && selectedPaths.has(path));
}

function normalizePath(value) {
  if (value == null) return null;
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function assertState(state) {
  if (!state?.analysis_id || !state?.graph || !state?.planning || !state?.ledger) {
    throw new TypeError('expand requires a retained analysis state');
  }
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
