export function getAnalysisRef(state, ref) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('analysis state is required');
  }
  const value = typeof ref === 'string' ? ref : ref?.ref ?? ref?.id;
  if (typeof value !== 'string' || !value) {
    throw new TypeError('stable ref is required');
  }

  const claim = state.ledger?.claims?.find(item => item.id === value);
  if (claim) return { kind: 'CLAIM', value: structuredClone(claim) };

  const evidence = state.ledger?.evidence?.find(item => item.id === value);
  if (evidence) return { kind: 'EVIDENCE', value: structuredClone(evidence) };

  const node = state.graph?.nodes?.find(item => item.id === value);
  if (node) return { kind: 'GRAPH_NODE', value: structuredClone(node) };

  const artifactEvidence = state.ledger?.evidence?.find(item => {
    const provenance = item.provenance ?? {};
    return provenance.artifact_id === value ||
      provenance.artifact_digest === value ||
      provenance.runtime_run_id === value;
  });
  if (artifactEvidence) {
    return {
      kind: 'ARTIFACT',
      value: {
        ref: value,
        evidence_id: artifactEvidence.id,
        provenance: structuredClone(artifactEvidence.provenance),
        evidence_kind: artifactEvidence.kind
      }
    };
  }

  return null;
}
