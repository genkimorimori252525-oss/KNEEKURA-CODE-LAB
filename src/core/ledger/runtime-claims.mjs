import {
  addClaim,
  createEvidenceLedgerFromGraph
} from './evidence-ledger.mjs';
import {
  createClaimEvidenceLink,
  createClaimRecord
} from './claims.mjs';
import { verifyAndRecordClaim } from '../verification/pipeline.mjs';
import { deriveClientCommandConsumed } from '../verification/derivations.mjs';

const OBSERVED_EDGE_CLAIMS = Object.freeze({
  OBSERVED_PACKET_SEND: 'runtime.packet_sent',
  OBSERVED_PACKET_RECEIVE: 'runtime.packet_received',
  OBSERVED_MOLANG_HANDLER_EXECUTION: 'ysm.molang_handler_executed',
  OBSERVED_YSM_MOLANG_COMMAND_DISPATCH: 'ysm.molang_command_dispatched',
  OBSERVED_YSM_CLIENT_COMMAND_HANDLED: 'ysm.client_command_handled',
  OBSERVED_YSM_MOLANG_STATE_APPLIED: 'ysm.molang_state_applied',
  OBSERVED_YSM_STATE_CORRELATED: 'ysm.state_correlated',
  OBSERVED_YSM_MOLANG_COMMAND_FAILURE: 'ysm.molang_command_failed',
  OBSERVED_YSM_CLIENT_COMMAND_FALLBACK: 'ysm.client_command_fallback'
});

export function importObservedRuntimeClaims(graph, ledger) {
  const groups = new Map();

  for (const edge of graph.edges ?? []) {
    const predicate = OBSERVED_EDGE_CLAIMS[edge.type];
    if (!predicate) continue;

    const target = graph.nodes?.find(node => node.id === edge.to);
    if (!target) continue;
    const key = predicate + '\0' + target.id;

    if (!groups.has(key)) {
      groups.set(key, {
        predicate,
        edge_type: edge.type,
        target,
        edges: []
      });
    }
    groups.get(key).edges.push(edge);
  }

  const claimIds = [];
  const skipped = [];

  for (const group of [...groups.values()].sort(compareGroup)) {
    const supportEvidence = directEvidenceForEdgeType(
      ledger,
      group.edge_type,
      group.edges
    );

    if (!supportEvidence.length) {
      skipped.push({
        predicate: group.predicate,
        node_id: group.target.id,
        reason: 'no canonical EvidenceRecord directly contains the observed graph fact'
      });
      continue;
    }

    const claim = createClaimRecord({
      type: 'OBSERVED',
      subject: subjectForNode(group.target),
      predicate: group.predicate,
      objectOrValue: true,
      evidenceLinks: supportEvidence.map(record =>
        createClaimEvidenceLink({
          evidenceId: record.id,
          role: 'SUPPORT',
          strength: 'DIRECT',
          rationale: 'provider EvidenceRecord graph delta contains ' + group.edge_type
        })
      ),
      counterevidenceLinks: [],
      dependencyClaimIds: [],
      coverageRef: ledger.coverage_ref,
      provenanceRefs: group.edges.map(edge => 'graph-edge:' + edge.id).sort()
    });

    addClaim(ledger, claim);
    claimIds.push(claim.id);
  }

  return { claim_ids: claimIds, skipped };
}

export function deriveSafeClaims(ledger) {
  const created = [];

  const handledClaims = ledger.claims
    .filter(claim =>
      claim.predicate === 'ysm.client_command_handled' &&
      claim.object_or_value === true &&
      ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const dependency of handledClaims) {
    const claim = deriveClientCommandConsumed(dependency, {
      coverageRef: dependency.coverage_ref,
      provenanceRefs: dependency.provenance_refs
    });

    if (!ledger.claims.some(existing => existing.id === claim.id)) {
      addClaim(ledger, claim);
      created.push(claim.id);
    }
  }

  return created;
}

export function buildVerifiedRuntimeLedger({
  graph,
  coverage,
  verificationContext = {}
}) {
  const ledger = createEvidenceLedgerFromGraph(graph, coverage);
  const imported = importObservedRuntimeClaims(graph, ledger);

  for (const claimId of imported.claim_ids) {
    verifyAndRecordClaim(ledger, claimId, {
      ...verificationContext,
      graph,
      coverage
    });
  }

  const derived = deriveSafeClaims(ledger);
  for (const claimId of derived) {
    verifyAndRecordClaim(ledger, claimId, {
      ...verificationContext,
      graph,
      coverage
    });
  }

  return {
    ledger,
    imported_claim_ids: imported.claim_ids,
    derived_claim_ids: derived,
    skipped: imported.skipped
  };
}

function directEvidenceForEdgeType(ledger, edgeType, edges) {
  const physicalSides = new Set(
    edges.map(edge => edge.physicalSide).filter(Boolean).map(String)
  );

  const candidates = ledger.evidence.filter(record =>
    record.kind === 'RUNTIME' &&
    Number(record.observation?.graph_delta?.edge_types?.[edgeType] ?? 0) > 0
  );

  const sideMatched = physicalSides.size
    ? candidates.filter(record =>
        record.observation?.physical_side &&
        physicalSides.has(String(record.observation.physical_side))
      )
    : [];

  return (sideMatched.length ? sideMatched : candidates)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

function subjectForNode(node) {
  return {
    node_id: node.id,
    kind: node.kind,
    key: node.key ?? null,
    label: node.label ?? null
  };
}

function compareGroup(a, b) {
  return a.predicate.localeCompare(b.predicate) ||
    a.target.id.localeCompare(b.target.id);
}
