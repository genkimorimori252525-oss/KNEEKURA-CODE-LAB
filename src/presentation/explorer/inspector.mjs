import {
  validateAnalysisResultV1
} from '../../core/schema/v1.mjs';
import {
  digestCanonicalAnalysisResult
} from '../../viewer/bundle.mjs';
import {
  validateExplorerGraph
} from './project.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA
} from './schema.mjs';

export const EXPLORER_CONFIDENCE_EVIDENCE_INSPECTOR_SCHEMA =
  'kneekura.explorer-confidence-evidence-inspector/v1';

export const INSPECTOR_EVIDENCE_INLINE = 'INLINE';
export const INSPECTOR_EVIDENCE_UNAVAILABLE_INLINE =
  'UNAVAILABLE_INLINE';

export function createExplorerConfidenceEvidenceInspector(
  projection,
  nodeId
) {
  assertInspectorProjection(projection);

  const id = String(nodeId ?? '');
  if (!id) {
    throw new TypeError(
      'Confidence/Evidence Inspector requires an exact canonical node ID'
    );
  }

  const result = projection.canonical.result;
  const nodeMeta = projection.presentation.nodes.find(
    item => item.node_id === id
  );
  if (!nodeMeta) return null;

  const canonicalNode =
    projection.canonical.graph.nodes[
      nodeMeta.canonical_index
    ];
  if (
    !canonicalNode ||
    canonicalNode.id !== id ||
    canonicalNode.kind !== nodeMeta.canonical_kind
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector node trace mismatch: ' +
      id
    );
  }

  const evidenceById = uniqueMap(
    result.evidence ?? [],
    item => item.id,
    'Canonical Evidence'
  );
  const evidenceRefs = new Set(
    result.evidence_refs ?? []
  );
  const counterevidenceRefs = new Set(
    result.counterevidence_refs ?? []
  );
  const coverageById = uniqueMap(
    result.coverage?.entries ?? [],
    item => item.id,
    'Canonical Coverage'
  );
  const presentationClaimById = uniqueMap(
    projection.presentation.claims,
    item => item.claim_id,
    'Presentation Claim'
  );
  const presentationCoverageById = uniqueMap(
    projection.presentation.coverage,
    item => item.coverage_id,
    'Presentation Coverage'
  );

  const claims = [];
  for (
    let canonicalIndex = 0;
    canonicalIndex < (result.claims ?? []).length;
    canonicalIndex++
  ) {
    const claim = result.claims[canonicalIndex];
    if (claim?.subject?.node_id !== id) continue;

    const meta = presentationClaimById.get(claim.id);
    assertClaimTrace(claim, meta, canonicalIndex);

    const coverage = coverageById.get(
      claim.coverage_ref
    );
    if (!coverage) {
      throw new TypeError(
        'Confidence/Evidence Inspector Claim coverage ref mismatch: ' +
        claim.id
      );
    }
    const coverageIndex =
      result.coverage.entries.findIndex(
        item => item.id === coverage.id
      );
    assertCoverageTrace(
      coverage,
      presentationCoverageById.get(coverage.id),
      coverageIndex
    );

    claims.push({
      canonical_index: canonicalIndex,
      claim_id: claim.id,
      type: claim.type,
      status: claim.status,
      subject: structuredClone(claim.subject),
      predicate: claim.predicate,
      object_or_value:
        structuredClone(claim.object_or_value),
      confidence:
        structuredClone(claim.confidence),
      coverage:
        structuredClone(coverage),
      evidence_links: resolveEvidenceLinks(
        claim.id,
        claim.evidence_links ?? [],
        'evidence_links',
        evidenceById,
        evidenceRefs
      ),
      counterevidence_links: resolveEvidenceLinks(
        claim.id,
        claim.counterevidence_links ?? [],
        'counterevidence_links',
        evidenceById,
        counterevidenceRefs
      ),
      dependency_claim_ids:
        structuredClone(
          claim.dependency_claim_ids ?? []
        ),
      provenance_refs:
        structuredClone(
          claim.provenance_refs ?? []
        ),
      verifier_results:
        structuredClone(
          claim.verifier_results ?? []
        ),
      unresolved_reason:
        typeof claim.unresolved_reason === 'string'
          ? claim.unresolved_reason
          : null
    });
  }

  const nodeCoverage = [];
  for (
    let canonicalIndex = 0;
    canonicalIndex <
      (result.coverage?.entries ?? []).length;
    canonicalIndex++
  ) {
    const coverage =
      result.coverage.entries[canonicalIndex];
    if (coverage?.node_id !== id) continue;
    assertCoverageTrace(
      coverage,
      presentationCoverageById.get(coverage.id),
      canonicalIndex
    );
    nodeCoverage.push(
      structuredClone(coverage)
    );
  }

  return {
    schema:
      EXPLORER_CONFIDENCE_EVIDENCE_INSPECTOR_SCHEMA,
    projection_schema: projection.schema,
    source: structuredClone(projection.source),
    node_id: id,
    canonical_node:
      structuredClone(canonicalNode),
    terminology:
      'Exact canonical confidence/evidence context; no score, ranking, or inferred conclusion',
    claims,
    node_coverage: nodeCoverage
  };
}

function resolveEvidenceLinks(
  claimId,
  links,
  sourceField,
  evidenceById,
  aggregateRefs
) {
  return links.map((link, linkIndex) => {
    const evidenceId = link?.evidence_id;
    const evidence = evidenceById.get(evidenceId);

    if (
      !evidence &&
      !aggregateRefs.has(evidenceId)
    ) {
      throw new TypeError(
        'Confidence/Evidence Inspector evidence link ref mismatch: ' +
        claimId + ' ' + sourceField + '[' +
        linkIndex + '] -> ' + String(evidenceId)
      );
    }

    return {
      source_field: sourceField,
      canonical_link_index: linkIndex,
      link: structuredClone(link),
      record_status: evidence
        ? INSPECTOR_EVIDENCE_INLINE
        : INSPECTOR_EVIDENCE_UNAVAILABLE_INLINE,
      evidence: evidence
        ? structuredClone(evidence)
        : null
    };
  });
}

function assertInspectorProjection(projection) {
  if (
    !projection ||
    projection.schema !==
      EXPLORER_PROJECTION_SCHEMA ||
    !projection.canonical?.graph ||
    !projection.canonical?.result ||
    !projection.presentation ||
    !Array.isArray(projection.presentation.nodes) ||
    !Array.isArray(projection.presentation.claims) ||
    !Array.isArray(projection.presentation.coverage)
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector requires ' +
      EXPLORER_PROJECTION_SCHEMA
    );
  }

  validateExplorerGraph(
    projection.canonical.graph
  );
  validateAnalysisResultV1(
    projection.canonical.result
  );

  const result = projection.canonical.result;
  const digest =
    digestCanonicalAnalysisResult(result);

  if (
    projection.source?.graph_schema !==
      projection.canonical.graph.schema ||
    projection.source?.analysis_result_schema !==
      result.schema ||
    projection.source?.analysis_result_digest !==
      digest ||
    projection.source?.analysis_id !==
      result.analysis_id ||
    projection.source?.session_id !==
      result.session_id ||
    projection.source?.snapshot_id !==
      result.snapshot?.snapshot_id
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector source identity/digest mismatch'
    );
  }

  if (
    projection.presentation.nodes.length !==
      projection.canonical.graph.nodes.length ||
    projection.presentation.claims.length !==
      (result.claims ?? []).length ||
    projection.presentation.coverage.length !==
      (result.coverage?.entries ?? []).length
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector trace count mismatch'
    );
  }

  for (const meta of projection.presentation.nodes) {
    const canonical =
      projection.canonical.graph.nodes[
        meta.canonical_index
      ];
    if (
      !canonical ||
      canonical.id !== meta.node_id ||
      canonical.kind !== meta.canonical_kind
    ) {
      throw new TypeError(
        'Confidence/Evidence Inspector node trace mismatch: ' +
        String(meta?.node_id)
      );
    }
  }

  for (const meta of projection.presentation.claims) {
    const claim =
      result.claims?.[meta.canonical_index];
    assertClaimTrace(
      claim,
      meta,
      meta.canonical_index
    );
  }

  for (const meta of projection.presentation.coverage) {
    const coverage =
      result.coverage?.entries?.[
        meta.canonical_index
      ];
    assertCoverageTrace(
      coverage,
      meta,
      meta.canonical_index
    );
  }
}

function assertClaimTrace(
  claim,
  meta,
  canonicalIndex
) {
  const subjectNodeId =
    typeof claim?.subject?.node_id === 'string'
      ? claim.subject.node_id
      : null;

  if (
    !claim ||
    !meta ||
    meta.canonical_index !== canonicalIndex ||
    meta.claim_id !== claim.id ||
    meta.subject_node_id !== subjectNodeId ||
    meta.type !== claim.type ||
    meta.status !== claim.status ||
    meta.coverage_ref !== claim.coverage_ref ||
    !sameJson(
      meta.evidence_links ?? [],
      claim.evidence_links ?? []
    ) ||
    !sameJson(
      meta.counterevidence_links ?? [],
      claim.counterevidence_links ?? []
    )
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector Claim trace mismatch: ' +
      String(claim?.id ?? meta?.claim_id)
    );
  }
}

function assertCoverageTrace(
  coverage,
  meta,
  canonicalIndex
) {
  const nodeId =
    typeof coverage?.node_id === 'string'
      ? coverage.node_id
      : null;

  if (
    !coverage ||
    !meta ||
    meta.canonical_index !== canonicalIndex ||
    meta.coverage_id !== coverage.id ||
    meta.node_id !== nodeId ||
    meta.role !== coverage.role ||
    meta.status !== coverage.status
  ) {
    throw new TypeError(
      'Confidence/Evidence Inspector Coverage trace mismatch: ' +
      String(coverage?.id ?? meta?.coverage_id)
    );
  }
}

function uniqueMap(items, keyFor, description) {
  const map = new Map();
  for (const item of items) {
    const key = String(keyFor(item));
    if (map.has(key)) {
      throw new TypeError(
        description + ' IDs must be unique: ' + key
      );
    }
    map.set(key, item);
  }
  return map;
}

function sameJson(left, right) {
  return JSON.stringify(left) ===
    JSON.stringify(right);
}
