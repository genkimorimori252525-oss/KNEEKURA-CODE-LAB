import {
  addVerificationRecord,
  getEvidence,
  replaceClaim
} from '../ledger/evidence-ledger.mjs';
import { applyVerificationResult } from '../ledger/claims.mjs';
import { evaluateNegativeGate } from './negative-gate.mjs';
import {
  aggregateVerificationStatus,
  createVerificationRecord,
  finding
} from './record.mjs';

const PREDICATE_EDGE = Object.freeze({
  'runtime.packet_sent': 'OBSERVED_PACKET_SEND',
  'runtime.packet_received': 'OBSERVED_PACKET_RECEIVE',
  'ysm.molang_handler_executed': 'OBSERVED_MOLANG_HANDLER_EXECUTION',
  'ysm.molang_command_dispatched': 'OBSERVED_YSM_MOLANG_COMMAND_DISPATCH',
  'ysm.client_command_handled': 'OBSERVED_YSM_CLIENT_COMMAND_HANDLED',
  'ysm.client_command_consumed': 'OBSERVED_YSM_CLIENT_COMMAND_HANDLED',
  'ysm.molang_state_applied': 'OBSERVED_YSM_MOLANG_STATE_APPLIED',
  'ysm.state_correlated': 'OBSERVED_YSM_STATE_CORRELATED',
  'ysm.molang_command_failed': 'OBSERVED_YSM_MOLANG_COMMAND_FAILURE',
  'ysm.client_command_fallback': 'OBSERVED_YSM_CLIENT_COMMAND_FALLBACK'
});

export const VERIFIER_CHAIN = Object.freeze([
  'snapshot',
  'anchor',
  'path',
  'evidence-role',
  'counterexample',
  'runtime-static',
  'coverage',
  'negative',
  'staleness'
]);

export function verifyClaim(claim, context) {
  if (!claim || typeof claim !== 'object') throw new TypeError('claim is required');
  if (!context?.ledger) throw new TypeError('verification context requires ledger');

  const records = [
    snapshotVerifier(claim, context),
    anchorVerifier(claim, context),
    pathVerifier(claim, context),
    evidenceRoleVerifier(claim, context),
    counterexampleVerifier(claim, context),
    runtimeStaticVerifier(claim, context),
    coverageVerifier(claim, context),
    negativeVerifier(claim, context),
    stalenessVerifier(claim, context)
  ];

  let status = aggregateVerificationStatus(records);
  if (claim.type === 'HYPOTHESIS' || claim.type === 'UNKNOWN') status = 'UNRESOLVED';

  const confidence = confidenceFor(status);
  const verifiedClaim = applyVerificationResult(claim, {
    status,
    verifierResults: records,
    confidence
  });

  return {
    claim: verifiedClaim,
    records,
    status
  };
}

export function verifyAndRecordClaim(ledger, claimId, context = {}) {
  const claim = ledger.claims.find(item => item.id === claimId);
  if (!claim) throw new Error('claim not found: ' + claimId);

  const result = verifyClaim(claim, {
    ...context,
    ledger
  });

  for (const record of result.records) addVerificationRecord(ledger, record);
  replaceClaim(ledger, result.claim);
  return result;
}

function snapshotVerifier(claim, context) {
  const evidence = linkedEvidence(claim, context.ledger);
  const current = currentSnapshotIds(context);

  for (const item of evidence) {
    if (!item) {
      return record('snapshot', 'REJECTED', claimRefs(claim), [
        finding('EVIDENCE_MISSING', 'claim references evidence that is not present in the Ledger', { severity: 'ERROR' })
      ]);
    }
    if (current.size && !current.has(item.provenance.snapshot_id)) {
      return record('snapshot', 'REJECTED', [item.id], [
        finding('SNAPSHOT_MISMATCH', 'linked evidence does not belong to the accepted frozen snapshot', {
          severity: 'ERROR',
          refs: [item.id],
          details: { evidence_snapshot_id: item.provenance.snapshot_id }
        })
      ]);
    }
  }

  return record('snapshot', 'VERIFIED', evidence.map(item => item.id), [
    finding('SNAPSHOT_OK', 'all linked evidence belongs to an accepted frozen snapshot')
  ]);
}

function anchorVerifier(claim, context) {
  const evidence = linkedEvidence(claim, context.ledger).filter(Boolean);
  const graph = context.graph;
  const paths = knownPaths(graph);
  const nodeIds = new Set((graph?.nodes ?? []).map(node => node.id));
  const nodeKeys = new Set((graph?.nodes ?? []).map(node => node.key).filter(Boolean));
  let limited = false;
  const findings = [];

  for (const item of evidence) {
    const p = item.provenance ?? {};
    let anchored = false;

    if (p.path) {
      anchored = paths.has(normalizePath(p.path));
      if (!anchored) {
        return record('anchor', 'REJECTED', [item.id], [
          finding('PATH_ANCHOR_MISSING', 'evidence path cannot be resolved in the frozen graph/snapshot', {
            severity: 'ERROR', refs: [item.id], details: { path: p.path }
          })
        ]);
      }
    }

    if (p.symbol_id) {
      anchored = true;
      if (!nodeIds.has(p.symbol_id) && !nodeKeys.has(p.symbol_id)) {
        return record('anchor', 'REJECTED', [item.id], [
          finding('SYMBOL_ANCHOR_MISSING', 'evidence symbol anchor cannot be resolved', {
            severity: 'ERROR', refs: [item.id], details: { symbol_id: p.symbol_id }
          })
        ]);
      }
    }

    if (p.artifact_id || p.artifact_digest || p.runtime_run_id || p.git_object_id) anchored = true;

    if (!anchored) {
      limited = true;
      findings.push(finding(
        'ANCHOR_COARSE',
        'evidence has snapshot provenance but no path/symbol/artifact/runtime anchor',
        { severity: 'WARN', refs: [item.id] }
      ));
    }
  }

  if (!findings.length) findings.push(finding('ANCHORS_OK', 'all linked evidence anchors resolve'));
  return record('anchor', limited ? 'VERIFIED_WITH_LIMITS' : 'VERIFIED', evidence.map(item => item.id), findings);
}

function pathVerifier(claim, context) {
  if (claim.type === 'NEGATIVE' || claim.type === 'UNKNOWN' || claim.type === 'HYPOTHESIS') {
    return record('path', claim.type === 'HYPOTHESIS' ? 'UNRESOLVED' : 'VERIFIED', [], [
      finding('PATH_NOT_APPLICABLE', 'claim type is not verified by positive graph-path reconstruction')
    ]);
  }

  const requiredEdge = PREDICATE_EDGE[claim.predicate];
  if (!requiredEdge) {
    return record('path', claim.type === 'OBSERVED' ? 'VERIFIED_WITH_LIMITS' : 'UNRESOLVED', claim.provenance_refs, [
      finding('PATH_RULE_UNAVAILABLE', 'no deterministic path rule is registered for this predicate', {
        severity: 'WARN', details: { predicate: claim.predicate }
      })
    ]);
  }

  const nodeId = resolveSubjectNodeId(claim.subject, context.graph);
  if (!nodeId) {
    return record('path', 'UNRESOLVED', claim.provenance_refs, [
      finding('SUBJECT_ANCHOR_UNRESOLVED', 'claim subject does not resolve to one exact graph node', {
        severity: 'WARN'
      })
    ]);
  }

  const edge = (context.graph?.edges ?? []).find(item =>
    item.type === requiredEdge && item.to === nodeId
  );
  if (!edge) {
    return record('path', 'REJECTED', [nodeId], [
      finding('REQUIRED_PATH_NOT_FOUND', 'required semantic graph edge is absent', {
        severity: 'ERROR',
        refs: [nodeId],
        details: { required_edge_type: requiredEdge }
      })
    ]);
  }

  return record('path', 'VERIFIED', [edge.id, nodeId], [
    finding('PATH_RECONSTRUCTED', 'required semantic graph path is present', {
      refs: [edge.id],
      details: { edge_type: requiredEdge }
    })
  ]);
}

function evidenceRoleVerifier(claim, context) {
  const ledger = context.ledger;
  const support = claim.evidence_links.filter(link => link.role === 'SUPPORT');
  const counter = claim.counterevidence_links.filter(link => link.role === 'CONTRADICT');
  const checked = [...support, ...counter].map(link => link.evidence_id);

  for (const link of [...claim.evidence_links, ...claim.counterevidence_links]) {
    if (!getEvidence(ledger, link.evidence_id)) {
      return record('evidence-role', 'REJECTED', checked, [
        finding('EVIDENCE_LINK_MISSING', 'claim link references missing evidence', {
          severity: 'ERROR', refs: [link.evidence_id]
        })
      ]);
    }
  }

  if (claim.type === 'OBSERVED') {
    const direct = support.filter(link => link.strength === 'DIRECT');
    if (!direct.length) {
      return record('evidence-role', 'REJECTED', checked, [
        finding('DIRECT_SUPPORT_REQUIRED', 'OBSERVED claim requires DIRECT SUPPORT evidence', { severity: 'ERROR' })
      ]);
    }

    const requiredEdge = PREDICATE_EDGE[claim.predicate];
    if (requiredEdge) {
      const matching = direct.some(link => {
        const evidence = getEvidence(ledger, link.evidence_id);
        return evidence?.kind === 'RUNTIME' &&
          Number(evidence.observation?.graph_delta?.edge_types?.[requiredEdge] ?? 0) > 0;
      });
      if (!matching) {
        return record('evidence-role', 'REJECTED', direct.map(link => link.evidence_id), [
          finding('DIRECT_RUNTIME_EVIDENCE_MISSING', 'direct evidence does not contain the required measured runtime fact', {
            severity: 'ERROR',
            details: { required_edge_type: requiredEdge }
          })
        ]);
      }
    }
  }

  if (claim.type === 'DERIVED') {
    const dependencies = claim.dependency_claim_ids.map(id =>
      ledger.claims.find(item => item.id === id)
    );
    if (dependencies.some(item => !item)) {
      return record('evidence-role', 'REJECTED', claim.dependency_claim_ids, [
        finding('DEPENDENCY_CLAIM_MISSING', 'DERIVED claim references a missing dependency claim', { severity: 'ERROR' })
      ]);
    }
    if (dependencies.some(item => !['VERIFIED','VERIFIED_WITH_LIMITS'].includes(item.status))) {
      return record('evidence-role', 'UNRESOLVED', claim.dependency_claim_ids, [
        finding('DEPENDENCY_NOT_VERIFIED', 'DERIVED claim depends on a claim that is not verified', { severity: 'WARN' })
      ]);
    }

    if (claim.derivation?.rule_id === 'core.derive.ysm-client-command-consumed') {
      const valid = dependencies.every(item =>
        item.predicate === 'ysm.client_command_handled' &&
        item.object_or_value === true
      );
      if (!valid) {
        return record('evidence-role', 'REJECTED', claim.dependency_claim_ids, [
          finding('DERIVATION_INPUT_INVALID', 'client-command-consumed derivation requires verified handled=true claims', {
            severity: 'ERROR'
          })
        ]);
      }
    } else {
      return record('evidence-role', 'UNRESOLVED', claim.dependency_claim_ids, [
        finding('DERIVATION_RULE_UNSUPPORTED', 'derivation rule is not registered as a safe deterministic rule', {
          severity: 'WARN',
          details: { rule_id: claim.derivation?.rule_id ?? null }
        })
      ]);
    }
  }

  return record('evidence-role', 'VERIFIED', checked, [
    finding('EVIDENCE_ROLES_OK', 'claim evidence links satisfy their required roles')
  ]);
}

function counterexampleVerifier(claim, context) {
  const links = claim.counterevidence_links;
  if (!links.length) {
    return record('counterexample', 'VERIFIED', [], [
      finding('NO_COUNTEREVIDENCE', 'no explicit counterevidence is linked to the claim')
    ]);
  }

  const direct = links.filter(link => link.strength === 'DIRECT');
  if (direct.length) {
    return record('counterexample', 'REJECTED', direct.map(link => link.evidence_id), [
      finding('DIRECT_COUNTEREVIDENCE', 'direct counterevidence contradicts the claim', {
        severity: 'ERROR',
        refs: direct.map(link => link.evidence_id)
      })
    ]);
  }

  return record('counterexample', 'VERIFIED_WITH_LIMITS', links.map(link => link.evidence_id), [
    finding('COUNTEREVIDENCE_LIMITS', 'indirect or correlated counterevidence limits the claim', {
      severity: 'WARN',
      refs: links.map(link => link.evidence_id)
    })
  ]);
}

function runtimeStaticVerifier(claim, context) {
  if (claim.type === 'NEGATIVE' || claim.type === 'UNKNOWN' || claim.type === 'HYPOTHESIS') {
    return record('runtime-static', 'VERIFIED', [], [
      finding('RUNTIME_STATIC_NOT_APPLICABLE', 'runtime/static positive leap checks are not applicable to this claim type')
    ]);
  }

  const graph = context.graph;
  const nodeId = resolveSubjectNodeId(claim.subject, graph);
  const incoming = nodeId
    ? (graph?.edges ?? []).filter(edge => edge.to === nodeId)
    : [];

  if (claim.predicate === 'runtime.packet_received') {
    const receive = incoming.find(edge => edge.type === 'OBSERVED_PACKET_RECEIVE');
    if (!receive) {
      const sent = incoming.some(edge => edge.type === 'OBSERVED_PACKET_SEND');
      return record('runtime-static', 'REJECTED', nodeId ? [nodeId] : [], [
        finding(
          sent ? 'SEND_IS_NOT_RECEIVE' : 'RECEIVE_NOT_OBSERVED',
          sent
            ? 'runtime packet send evidence cannot be promoted into receive evidence'
            : 'runtime packet receive was not observed',
          { severity: 'ERROR' }
        )
      ]);
    }
  }

  if (claim.predicate === 'ysm.client_command_consumed' || claim.predicate === 'ysm.client_command_handled') {
    const handled = incoming.find(edge =>
      edge.type === 'OBSERVED_YSM_CLIENT_COMMAND_HANDLED' &&
      edge.handledByClient !== false
    );
    if (!handled) {
      const fallback = incoming.some(edge => edge.type === 'OBSERVED_YSM_CLIENT_COMMAND_FALLBACK');
      return record('runtime-static', 'REJECTED', nodeId ? [nodeId] : [], [
        finding(
          fallback ? 'FALLBACK_IS_NOT_M5' : 'M5_NOT_OBSERVED',
          fallback
            ? 'Forge client-command fallback cannot be promoted into M5 consumed/handled evidence'
            : 'M5 client command consumed evidence is absent',
          { severity: 'ERROR' }
        )
      ]);
    }
  }

  if (claim.predicate === 'ysm.molang_state_applied') {
    const applied = incoming.find(edge => edge.type === 'OBSERVED_YSM_MOLANG_STATE_APPLIED');
    if (!applied) {
      const m5 = incoming.some(edge => edge.type === 'OBSERVED_YSM_CLIENT_COMMAND_HANDLED');
      const weak = incoming.some(edge => edge.type === 'OBSERVED_YSM_STATE_CORRELATED');
      return record('runtime-static', 'REJECTED', nodeId ? [nodeId] : [], [
        finding(
          weak ? 'WEAK_CORRELATION_IS_NOT_M6' : m5 ? 'M5_IS_NOT_M6' : 'M6_NOT_OBSERVED',
          weak
            ? 'weak state correlation cannot be promoted into formal M6 applied-state evidence'
            : m5
              ? 'M5 command consumption does not prove M6 YSM runtime state application'
              : 'formal M6 applied-state evidence is absent',
          { severity: 'ERROR' }
        )
      ]);
    }

    const qualified =
      applied.controlledE2Qualified === true &&
      applied.exactVariableIdentity === true &&
      applied.evidenceLevel === 'E2_ACTUAL_PRE_POST_TRANSITION';
    if (!qualified) {
      return record('runtime-static', 'REJECTED', [applied.id], [
        finding('M6_EVIDENCE_NOT_FORMALLY_QUALIFIED', 'M6 edge lacks the required controlled E2 exact-variable transition evidence', {
          severity: 'ERROR', refs: [applied.id]
        })
      ]);
    }
  }

  return record('runtime-static', 'VERIFIED', nodeId ? [nodeId] : [], [
    finding('NO_UNSUPPORTED_RUNTIME_LEAP', 'claim does not cross an unsupported runtime/static boundary')
  ]);
}

function coverageVerifier(claim, context) {
  if (claim.type === 'NEGATIVE') {
    return record('coverage', 'VERIFIED', [claim.coverage_ref], [
      finding('NEGATIVE_COVERAGE_DEFERRED', 'negative coverage authority is enforced by the dedicated negative gate')
    ]);
  }

  const coverage = context.coverage ?? context.ledger.coverage;
  if (!coverage) {
    return record('coverage', 'UNRESOLVED', [claim.coverage_ref], [
      finding('COVERAGE_MISSING', 'claim cannot be qualified without a Coverage Manifest', { severity: 'WARN' })
    ]);
  }

  if (coverage.completeness === 'COMPLETE') {
    return record('coverage', 'VERIFIED', [claim.coverage_ref], [
      finding('COVERAGE_COMPLETE', 'claim is evaluated against complete selected coverage')
    ]);
  }

  if (coverage.completeness === 'BOUNDED') {
    return record('coverage', 'VERIFIED_WITH_LIMITS', [claim.coverage_ref], [
      finding('COVERAGE_BOUNDED', 'claim is valid only within the explicit coverage boundary', { severity: 'WARN' })
    ]);
  }

  const directObserved = claim.type === 'OBSERVED' && claim.evidence_links.some(link =>
    link.role === 'SUPPORT' && link.strength === 'DIRECT'
  );
  return record(
    'coverage',
    directObserved ? 'VERIFIED_WITH_LIMITS' : 'UNRESOLVED',
    [claim.coverage_ref],
    [finding(
      'COVERAGE_INCOMPLETE',
      directObserved
        ? 'direct observation remains usable but global completeness is limited'
        : 'claim cannot be finalized over partial or unknown coverage',
      { severity: 'WARN', details: { completeness: coverage.completeness } }
    )]
  );
}

function negativeVerifier(claim, context) {
  if (claim.type !== 'NEGATIVE') {
    return record('negative', 'VERIFIED', [], [
      finding('NEGATIVE_NOT_APPLICABLE', 'claim is not a NEGATIVE claim')
    ]);
  }

  const negativeContext = selectNegativeContext(claim, context);
  const evidence = linkedEvidence(claim, context.ledger).filter(Boolean);
  const result = evaluateNegativeGate({
    searchedProperty: negativeContext.searched_property ?? claim.predicate,
    providerId: negativeContext.provider_id ?? null,
    graph: context.graph,
    coverage: context.coverage ?? context.ledger.coverage,
    searchUniverse: negativeContext.search_universe,
    irrelevantItemIds: negativeContext.irrelevant_item_ids ?? [],
    evidenceRecords: evidence,
    counterevidenceLinks: claim.counterevidence_links,
    currentSnapshotIds: [...currentSnapshotIds(context)],
    staleEvidenceIds: context.staleEvidenceIds ?? [],
    stale: context.staleSnapshot === true || negativeContext.stale === true
  });

  return record(
    'negative',
    result.allowed ? 'VERIFIED' : 'UNRESOLVED',
    [...claimRefs(claim), ...(result.search_universe_id ? [result.search_universe_id] : [])],
    [finding(
      result.reason_code,
      result.message,
      {
        severity: result.allowed ? 'INFO' : 'WARN',
        details: {
          outcome: result.outcome,
          ...(result.details ?? {}),
          ...(result.provider_ids ? { provider_ids: result.provider_ids } : {})
        }
      }
    )]
  );
}

function stalenessVerifier(claim, context) {
  const staleIds = new Set(context.staleEvidenceIds ?? []);
  const linked = linkedEvidence(claim, context.ledger).filter(Boolean);

  if (context.staleSnapshot === true) {
    return record('staleness', 'REJECTED', claimRefs(claim), [
      finding('STALE_SNAPSHOT', 'verification context is marked stale', { severity: 'ERROR' })
    ]);
  }

  const stale = linked.find(item => staleIds.has(item.id));
  if (stale) {
    return record('staleness', 'REJECTED', [stale.id], [
      finding('STALE_EVIDENCE', 'claim depends on explicitly stale evidence', {
        severity: 'ERROR', refs: [stale.id]
      })
    ]);
  }

  const current = currentSnapshotIds(context);
  const mismatch = current.size
    ? linked.find(item => !current.has(item.provenance.snapshot_id))
    : null;
  if (mismatch) {
    return record('staleness', 'REJECTED', [mismatch.id], [
      finding('STALE_SNAPSHOT', 'claim evidence belongs to a non-current snapshot', {
        severity: 'ERROR', refs: [mismatch.id]
      })
    ]);
  }

  return record('staleness', 'VERIFIED', linked.map(item => item.id), [
    finding('NOT_STALE', 'claim dependencies are current')
  ]);
}

function selectNegativeContext(claim, context) {
  if (context.negativeContexts instanceof Map) {
    return context.negativeContexts.get(claim.id) ?? {};
  }
  if (context.negativeContexts && typeof context.negativeContexts === 'object') {
    return context.negativeContexts[claim.id] ?? {};
  }
  return context.negativeContext ?? {};
}

function linkedEvidence(claim, ledger) {
  return [...claim.evidence_links, ...claim.counterevidence_links].map(link =>
    getEvidence(ledger, link.evidence_id)
  );
}

function currentSnapshotIds(context) {
  const ids = new Set(context.currentSnapshotIds ?? context.ledger.snapshot_ids ?? []);
  const graph = context.graph;
  if (graph?.meta?.snapshot?.snapshot_id) ids.add(graph.meta.snapshot.snapshot_id);
  for (const constituent of graph?.meta?.snapshot?.constituents ?? []) {
    if (constituent.snapshot_id) ids.add(constituent.snapshot_id);
  }
  for (const entry of graph?.meta?.repositories ?? []) {
    if (entry.snapshot?.snapshot_id) ids.add(entry.snapshot.snapshot_id);
  }
  return ids;
}

function knownPaths(graph) {
  const paths = new Set();
  for (const node of graph?.nodes ?? []) if (node.path) paths.add(normalizePath(node.path));
  for (const entry of graph?.meta?.snapshot?.content_manifest ?? []) {
    if (entry.path) paths.add(normalizePath(entry.path));
  }
  for (const repo of graph?.meta?.repositories ?? []) {
    for (const entry of repo.snapshot?.content_manifest ?? []) {
      if (entry.path) paths.add(normalizePath(entry.path));
    }
  }
  return paths;
}

function resolveSubjectNodeId(subject, graph) {
  if (!graph?.nodes) return null;
  if (subject && typeof subject === 'object' && typeof subject.node_id === 'string') {
    return graph.nodes.some(node => node.id === subject.node_id) ? subject.node_id : null;
  }

  if (typeof subject !== 'string') return null;
  if (graph.nodes.some(node => node.id === subject)) return subject;

  if (subject.startsWith('node:')) {
    const id = subject.slice(5);
    return graph.nodes.some(node => node.id === id) ? id : null;
  }

  const candidates = graph.nodes.filter(node =>
    node.key === subject || node.label === subject
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

function claimRefs(claim) {
  return [
    ...claim.evidence_links.map(link => link.evidence_id),
    ...claim.counterevidence_links.map(link => link.evidence_id),
    ...claim.dependency_claim_ids,
    ...claim.provenance_refs
  ];
}

function confidenceFor(status) {
  if (status === 'VERIFIED') return {
    level: 'HIGH',
    rationale: 'all deterministic verifier passes succeeded'
  };
  if (status === 'VERIFIED_WITH_LIMITS') return {
    level: 'MEDIUM',
    rationale: 'deterministic verification succeeded with explicit coverage/evidence limits'
  };
  return {
    level: 'LOW',
    rationale: status === 'REJECTED'
      ? 'deterministic verification rejected the claim'
      : 'verification could not establish the claim'
  };
}

function record(id, status, checkedRefs, findings) {
  return createVerificationRecord({
    verifierId: 'core.verifier.' + id,
    verifierVersion: 'v1',
    status,
    checkedRefs,
    findings
  });
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}
