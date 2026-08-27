import crypto from 'node:crypto';
import {
  ANALYSIS_RESULT_SCHEMA,
  validateAnalysisRequestV1,
  validateAnalysisResultV1
} from '../schema/v1.mjs';
import { scanRepository } from '../scan.mjs';
import { planDeterministicAnalysis } from '../planning.mjs';
import {
  addClaim,
  createEvidenceLedgerFromGraph,
  finalizeEvidenceLedger
} from '../ledger/evidence-ledger.mjs';
import {
  createClaimEvidenceLink,
  createClaimRecord
} from '../ledger/claims.mjs';
import {
  deriveSafeClaims,
  importObservedRuntimeClaims
} from '../ledger/runtime-claims.mjs';
import { verifyAndRecordClaim } from '../verification/pipeline.mjs';
import { createExplorationLedger } from '../session/exploration-ledger.mjs';
import {
  createReasoningTask
} from '../reasoning/bridge.mjs';
import { packEvidenceCapsule } from '../reasoning/capsule.mjs';

export const CORE_ENGINE_ID = 'kneekura-core';
export const CORE_ENGINE_VERSION = 'public-api-v1';
export const CORE_ENGINE_FINGERPRINT =
  'sha256:' + crypto.createHash('sha256')
    .update(CORE_ENGINE_ID + '\0' + CORE_ENGINE_VERSION)
    .digest('hex');

export async function analyze(request, options = {}) {
  const execution = await analyzeInternal(request, options);
  return execution.result;
}

export async function analyzeInternal(request, options = {}) {
  validateAnalysisRequestV1(request);

  const repositoryRoot = repositoryRootFor(request, options);
  const bufferedEvents = [];
  const explorationLedger =
    options.explorationLedger ??
    createExplorationLedger();

  const graph = await scanRepository(repositoryRoot, {
    ...scanOptionsForRequest(request, options.scan ?? {}),
    explorationLedger,
    requiredEvidenceFidelity: options.requiredEvidenceFidelity ?? 0,
    onSessionEvent: async (type, payload) => {
      bufferedEvents.push({
        type,
        payload: structuredClone(payload)
      });
    }
  });

  assertRequestedRepositoryIdentity(request.repository, graph.meta?.repository);
  explorationLedger.snapshot_id = graph.meta?.snapshot?.snapshot_id ?? null;

  const planning = planDeterministicAnalysis(
    graph,
    request,
    options.planning ?? {}
  );
  const analysisId = analysisIdentity({
    request,
    graph,
    planning,
    bridge: options.reasoningBridge ?? null
  });
  const sessionId =
    options.sessionId ??
    (options.sessionStore
      ? 'session:' + crypto.randomUUID()
      : 'session:sha256:' + analysisId.slice('analysis:sha256:'.length));

  const session = createSessionRecorder({
    store: options.sessionStore ?? null,
    sessionId
  });

  await session.start({
    normalizedRequest: request,
    targetSnapshotId: graph.meta.snapshot.snapshot_id,
    engineFingerprint: CORE_ENGINE_FINGERPRINT,
    ruleFingerprints: [planning.rules.resolution_fingerprint]
  });
  await session.append('SNAPSHOT_FROZEN', {
    snapshot: graph.meta.snapshot
  });
  for (const decision of planning.scope.decisions) {
    await session.append('SCOPE_DECISION', { decision });
  }
  for (const event of bufferedEvents) {
    await session.append(event.type, event.payload);
  }
  await session.append('COVERAGE_CHANGED', {
    coverage: planning.coverage
  });

  const ledger = createEvidenceLedgerFromGraph(graph, planning.coverage);
  const verificationContext = {
    ...(options.verificationContext ?? {}),
    graph,
    coverage: planning.coverage
  };

  const imported = importObservedRuntimeClaims(graph, ledger);
  for (const claimId of imported.claim_ids) {
    const claim = ledger.claims.find(item => item.id === claimId);
    await session.append('CLAIM_PROPOSED', {
      claim: structuredClone(claim)
    });
    const verified = verifyAndRecordClaim(
      ledger,
      claimId,
      verificationContext
    );
    await appendVerificationEvent(session, verified.claim);
  }

  const firstDerived = deriveSafeClaims(ledger);
  for (const claimId of firstDerived) {
    const claim = ledger.claims.find(item => item.id === claimId);
    await session.append('CLAIM_PROPOSED', {
      claim: structuredClone(claim)
    });
    const verified = verifyAndRecordClaim(
      ledger,
      claimId,
      verificationContext
    );
    await appendVerificationEvent(session, verified.claim);
  }

  let capsule = packEvidenceCapsule({
    request,
    graph,
    planning,
    ledger,
    profile: request.output_profile ?? options.outputProfile ?? 'standard',
    budget: request.budget ?? {}
  });
  await session.append('METRICS_UPDATED', {
    metrics: {
      evidence_ids_sent_to_reasoning_bridge:
        options.reasoningBridge ? capsule.evidence.length : 0,
      raw_excerpt_bytes_packed:
        options.reasoningBridge ? capsule.metrics.raw_excerpt_bytes : 0,
      raw_excerpt_tokens_packed:
        options.reasoningBridge ? capsule.metrics.raw_excerpt_tokens : 0
    }
  });

  const proposalOutcomes = [];
  let bridgeFailure = null;

  if (options.reasoningBridge) {
    try {
      const task = createReasoningTask({
        analysisId,
        request,
        capsule,
        selectedNodeIds: planning.scope.items
          .filter(item => item.selected !== false && item.node_id)
          .map(item => item.node_id),
        existingClaimIds: ledger.claims.map(claim => claim.id)
      });
      const proposalSet = await options.reasoningBridge.reason(task);
      for (let index = 0; index < proposalSet.proposals.length; index++) {
        const proposal = proposalSet.proposals[index];
        const outcome = await ingestBridgeProposal({
          proposal,
          index,
          ledger,
          graph,
          planning,
          capsule,
          verificationContext,
          session
        });
        proposalOutcomes.push(outcome);
      }
    } catch (error) {
      bridgeFailure = {
        code: 'REASONING_BRIDGE_FAILED',
        message: String(error?.message ?? error)
      };
    }
  }

  const secondDerived = deriveSafeClaims(ledger);
  for (const claimId of secondDerived) {
    const claim = ledger.claims.find(item => item.id === claimId);
    await session.append('CLAIM_PROPOSED', {
      claim: structuredClone(claim)
    });
    const verified = verifyAndRecordClaim(
      ledger,
      claimId,
      verificationContext
    );
    await appendVerificationEvent(session, verified.claim);
  }

  const ledgerSnapshot = finalizeEvidenceLedger(ledger);
  const warnings = collectWarnings({
    graph,
    imported,
    proposalOutcomes,
    capsule,
    bridgeFailure
  });
  const failures = collectFailures(graph, bridgeFailure);
  const result = buildAnalysisResult({
    analysisId,
    sessionId,
    request,
    graph,
    planning,
    ledgerSnapshot,
    proposalOutcomes,
    capsule,
    warnings,
    failures
  });

  validateAnalysisResultV1(result);

  await session.append('SESSION_FINALIZED', {
    coverage: result.coverage,
    claims: result.claims
  });
  if (options.sessionStore) {
    await options.sessionStore.writeExplorationLedger(
      sessionId,
      explorationLedger
    );
    await options.sessionStore.writeMaterializedState(sessionId);
  }

  return {
    result,
    state: {
      analysis_id: analysisId,
      session_id: sessionId,
      repository_root: repositoryRoot,
      engine_fingerprint: CORE_ENGINE_FINGERPRINT,
      expansion_planning_options: structuredClone(options.planning ?? {}),
      request: structuredClone(request),
      graph,
      planning,
      current_coverage: structuredClone(planning.coverage),
      ledger,
      ledger_snapshot: ledgerSnapshot,
      capsule,
      exploration_ledger: explorationLedger,
      proposal_outcomes: proposalOutcomes,
      session_store: options.sessionStore ?? null,
      verification_context: structuredClone(
        options.verificationContext ?? {}
      )
    }
  };
}

async function ingestBridgeProposal({
  proposal,
  index,
  ledger,
  graph,
  planning,
  capsule,
  verificationContext,
  session
}) {
  try {
    const subject = normalizeProposalSubject(
      proposal.subject,
      graph,
      planning.scope
    );
    assertProposalEvidenceVisible(proposal, capsule, ledger);

    const evidenceLinks = proposal.evidence_ids.map(evidenceId =>
      createClaimEvidenceLink({
        evidenceId,
        role: 'SUPPORT',
        strength: 'INDIRECT',
        rationale: 'ReasoningBridge proposal cites existing canonical evidence'
      })
    );
    const counterevidenceLinks = proposal.counterevidence_ids.map(evidenceId =>
      createClaimEvidenceLink({
        evidenceId,
        role: 'CONTRADICT',
        strength: 'INDIRECT',
        rationale: 'ReasoningBridge proposal preserves cited counterevidence'
      })
    );

    const claim = createClaimRecord({
      type: proposal.type,
      subject,
      predicate: proposal.predicate,
      objectOrValue: proposal.object_or_value,
      evidenceLinks,
      counterevidenceLinks,
      dependencyClaimIds: proposal.dependency_claim_ids,
      coverageRef: ledger.coverage_ref,
      provenanceRefs: [
        'reasoning-bridge:proposal:' + index,
        ...proposal.provenance_refs
      ],
      unresolvedReason: proposal.unresolved_reason ?? null
    });

    const existing = ledger.claims.find(item => item.id === claim.id);
    if (existing) {
      return {
        proposal_index: index,
        status: 'ACCEPTED_EXISTING',
        claim_id: existing.id,
        verification_status: existing.status
      };
    }

    addClaim(ledger, claim);
    await session.append('CLAIM_PROPOSED', {
      claim: structuredClone(claim)
    });

    const negativeContexts = proposal.type === 'NEGATIVE'
      ? new Map([[claim.id, proposal.negative_context ?? {}]])
      : undefined;
    const verified = verifyAndRecordClaim(ledger, claim.id, {
      ...verificationContext,
      graph,
      coverage: planning.coverage,
      ...(negativeContexts ? { negativeContexts } : {})
    });
    await appendVerificationEvent(session, verified.claim);

    return {
      proposal_index: index,
      status: 'ACCEPTED',
      claim_id: claim.id,
      verification_status: verified.status
    };
  } catch (error) {
    return {
      proposal_index: index,
      status: 'REJECTED',
      code: proposalErrorCode(error),
      message: String(error?.message ?? error)
    };
  }
}

function normalizeProposalSubject(subject, graph, scope) {
  const selected = new Set(
    scope.items
      .filter(item => item.selected !== false && item.node_id)
      .map(item => item.node_id)
  );

  let node = null;
  if (
    subject &&
    typeof subject === 'object' &&
    typeof subject.node_id === 'string'
  ) {
    node = graph.nodes.find(item => item.id === subject.node_id) ?? null;
  } else {
    const value =
      typeof subject === 'string'
        ? subject
        : subject?.key ?? subject?.symbol ?? subject?.label;
    if (value != null) {
      const candidates = graph.nodes.filter(item =>
        String(item.key ?? '') === String(value) ||
        String(item.label ?? '') === String(value)
      );
      const selectedCandidates = candidates.filter(item =>
        selected.has(item.id)
      );
      if (selectedCandidates.length > 1) {
        throw codedError(
          'PROPOSAL_SUBJECT_AMBIGUOUS',
          'proposal subject resolves to multiple selected candidates'
        );
      }
      node = selectedCandidates[0] ?? null;
      if (!node && candidates.length) {
        throw codedError(
          'PROPOSAL_SUBJECT_OUT_OF_SCOPE',
          'proposal subject exists but is outside the deterministic candidate set'
        );
      }
    }
  }

  if (!node) {
    throw codedError(
      'PROPOSAL_SUBJECT_UNRESOLVED',
      'proposal subject does not resolve to one selected graph node'
    );
  }
  if (!selected.has(node.id)) {
    throw codedError(
      'PROPOSAL_SUBJECT_OUT_OF_SCOPE',
      'proposal subject is outside the deterministic candidate set'
    );
  }

  return {
    node_id: node.id,
    kind: node.kind,
    key: node.key ?? null,
    label: node.label ?? null
  };
}

function assertProposalEvidenceVisible(proposal, capsule, ledger) {
  const visible = new Set(capsule.evidence.map(item => item.id));
  const stored = new Set(ledger.evidence.map(item => item.id));
  for (const evidenceId of [
    ...proposal.evidence_ids,
    ...proposal.counterevidence_ids
  ]) {
    if (!stored.has(evidenceId)) {
      throw codedError(
        'PROPOSAL_EVIDENCE_UNKNOWN',
        'proposal cites evidence that is not present in the canonical Ledger: ' +
        evidenceId
      );
    }
    if (!visible.has(evidenceId)) {
      throw codedError(
        'PROPOSAL_EVIDENCE_NOT_IN_CAPSULE',
        'proposal cites evidence that was not supplied in its Evidence Capsule: ' +
        evidenceId
      );
    }
  }
  const claims = new Set(ledger.claims.map(item => item.id));
  for (const claimId of proposal.dependency_claim_ids) {
    if (!claims.has(claimId)) {
      throw codedError(
        'PROPOSAL_DEPENDENCY_UNKNOWN',
        'proposal cites an unknown dependency Claim: ' + claimId
      );
    }
  }
}

function buildAnalysisResult({
  analysisId,
  sessionId,
  graph,
  planning,
  ledgerSnapshot,
  proposalOutcomes,
  capsule,
  warnings,
  failures
}) {
  const claims = ledgerSnapshot.claims
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const evidence = ledgerSnapshot.evidence
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const evidenceRefs = canonicalStrings(
    claims.flatMap(claim =>
      claim.evidence_links
        .filter(link => link.role === 'SUPPORT')
        .map(link => link.evidence_id)
    )
  );
  const counterevidenceRefs = canonicalStrings(
    claims.flatMap(claim =>
      claim.counterevidence_links
        .filter(link => link.role === 'CONTRADICT')
        .map(link => link.evidence_id)
    )
  );

  const unknowns = [
    ...planning.coverage.entries
      .filter(entry => ['FAILED','UNEXPLORED'].includes(entry.status))
      .map(entry => ({
        kind: 'COVERAGE',
        ref: entry.id,
        reason: entry.reason,
        reason_code: entry.reason_code ?? null
      })),
    ...claims
      .filter(claim => claim.status === 'UNRESOLVED')
      .map(claim => ({
        kind: 'CLAIM',
        ref: claim.id,
        reason:
          claim.unresolved_reason ??
          'claim remains unresolved after verification'
      }))
  ].sort(compareUnknown);

  const rejectedProposals = proposalOutcomes
    .filter(item => item.status === 'REJECTED')
    .map(item => ({
      kind: 'REASONING_PROPOSAL',
      proposal_index: item.proposal_index,
      code: item.code,
      reason: item.message
    }));

  const negatedHypotheses = [
    ...claims
      .filter(claim =>
        claim.status === 'REJECTED' ||
        (claim.type === 'HYPOTHESIS' && claim.status === 'UNRESOLVED')
      )
      .map(claim => ({
        claim_id: claim.id,
        type: claim.type,
        status: claim.status
      })),
    ...rejectedProposals
  ];

  const status = runStatus({
    coverage: planning.coverage,
    capsule,
    failures
  });

  return {
    schema: ANALYSIS_RESULT_SCHEMA,
    analysis_id: analysisId,
    session_id: sessionId,
    repository: structuredClone(graph.meta.repository),
    snapshot: structuredClone(graph.meta.snapshot),
    status,
    claims,
    evidence,
    evidence_refs: evidenceRefs,
    counterevidence_refs: counterevidenceRefs,
    graph_paths: capsule.graph_paths.map(item => structuredClone(item)),
    affected_symbols: affectedSymbols(graph, planning.scope),
    negated_hypotheses: negatedHypotheses,
    coverage: structuredClone(planning.coverage),
    unknowns,
    verifier_records: ledgerSnapshot.verification_records
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    failures,
    recommended_validation: recommendedValidation(claims, planning.coverage)
  };
}

function collectWarnings({
  graph,
  imported,
  proposalOutcomes,
  capsule,
  bridgeFailure
}) {
  const warnings = [];
  for (const item of imported.skipped ?? []) {
    warnings.push({
      code: 'RUNTIME_CLAIM_SKIPPED',
      message: item.reason,
      predicate: item.predicate,
      node_id: item.node_id
    });
  }
  for (const outcome of proposalOutcomes) {
    if (outcome.status === 'REJECTED') {
      warnings.push({
        code: outcome.code,
        message: outcome.message,
        proposal_index: outcome.proposal_index
      });
    }
  }
  if (capsule.budget.budget_exhausted) {
    warnings.push({
      code: 'BUDGET_EXHAUSTED',
      message:
        'Evidence Capsule budget omitted required/high-priority evidence'
    });
  }
  if (bridgeFailure) warnings.push(structuredClone(bridgeFailure));
  for (const unresolved of graph.meta?.unresolvedReferences ?? []) {
    warnings.push({
      code: 'UNRESOLVED_REFERENCE',
      message: 'provider reported an unresolved reference',
      ref: structuredClone(unresolved)
    });
  }
  return warnings;
}

function collectFailures(graph, bridgeFailure) {
  const failures = (graph.meta?.providerFailures ?? [])
    .map(item => ({
      code: item.code,
      message: item.message,
      provider_id: item.provider_id,
      provider_version: item.provider_version,
      unit_ref: item.unit_ref ?? null
    }));
  if (bridgeFailure) failures.push(structuredClone(bridgeFailure));
  return failures;
}

function runStatus({ coverage, capsule, failures }) {
  if (coverage.completeness === 'PARTIAL' ||
      coverage.completeness === 'UNKNOWN' ||
      capsule.budget.budget_exhausted ||
      failures.some(item => item.code === 'REASONING_BRIDGE_FAILED')) {
    return 'PARTIAL';
  }
  return 'COMPLETE';
}

function affectedSymbols(graph, scope) {
  const selected = new Set(
    scope.items
      .filter(item => item.selected !== false && item.node_id)
      .map(item => item.node_id)
  );
  return graph.nodes
    .filter(node => selected.has(node.id))
    .map(node => ({
      node_id: node.id,
      kind: node.kind,
      key: node.key ?? null,
      label: node.label ?? null,
      ...(node.path ? { path: node.path } : {})
    }))
    .sort((a, b) => a.node_id.localeCompare(b.node_id));
}

function recommendedValidation(claims, coverage) {
  const rows = [];
  const hasM5 = claims.some(claim =>
    claim.predicate === 'ysm.client_command_consumed' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  );
  const hasM6 = claims.some(claim =>
    claim.predicate === 'ysm.molang_state_applied' &&
    ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
  );
  if (hasM5 && !hasM6) {
    rows.push({
      code: 'M6_RUNTIME_VALIDATION_RECOMMENDED',
      message:
        'M5 is verified but formal M6 applied-state evidence is not verified'
    });
  }
  if (['PARTIAL','UNKNOWN'].includes(coverage.completeness)) {
    rows.push({
      code: 'EXPAND_COVERAGE_RECOMMENDED',
      message:
        'expand unresolved/failed coverage before making global conclusions'
    });
  }
  return rows;
}

function repositoryRootFor(request, options) {
  if (typeof request.repository === 'string') {
    return request.repository;
  }
  if (
    typeof options.repositoryRoot === 'string' &&
    options.repositoryRoot.trim()
  ) {
    return options.repositoryRoot;
  }
  throw new TypeError(
    'repositoryRoot option is required when AnalysisRequest.repository is an identity object'
  );
}

function assertRequestedRepositoryIdentity(requestRepository, actual) {
  if (typeof requestRepository === 'string') return;
  if (
    !actual?.repository_id ||
    actual.repository_id !== requestRepository.repository_id
  ) {
    throw codedError(
      'REPOSITORY_IDENTITY_MISMATCH',
      'requested RepositoryIdentity does not match the scanned repository'
    );
  }
}

function scanOptionsForRequest(request, base) {
  const next = {
    ...structuredClone(base),
    network: [...(base.network ?? [])]
  };

  for (const artifact of request.runtime_artifacts ?? []) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      continue;
    }
    const kind = String(artifact.kind ?? artifact.type ?? '').toLowerCase();
    const file = artifact.path ?? artifact.file;
    if (typeof file !== 'string' || !file) continue;
    if (kind === 'trace') next.trace ??= file;
    else if (kind === 'pose') next.pose ??= file;
    else if (kind === 'palette') next.palette ??= file;
    else if (kind === 'network' || kind === 'net') next.network.push(file);
  }
  return next;
}

function analysisIdentity({ request, graph, planning, bridge }) {
  const digest = crypto.createHash('sha256')
    .update(stableStringify({
      engine_fingerprint: CORE_ENGINE_FINGERPRINT,
      repository_id: graph.meta.repository.repository_id,
      snapshot_id: graph.meta.snapshot.snapshot_id,
      request,
      planning_fingerprint: planning.deterministic_fingerprint,
      reasoning_bridge: bridge
        ? { id: bridge.id, version: bridge.version }
        : null
    }))
    .digest('hex');
  return 'analysis:sha256:' + digest;
}

function createSessionRecorder({ store, sessionId }) {
  let started = false;
  return {
    async start({
      normalizedRequest,
      targetSnapshotId,
      engineFingerprint,
      ruleFingerprints
    }) {
      if (!store) {
        started = true;
        return;
      }
      await store.startSession({
        sessionId,
        normalizedRequest,
        targetSnapshotId,
        engineFingerprint,
        ruleFingerprints
      });
      started = true;
    },

    async append(type, payload) {
      if (!started) throw new Error('analysis session has not started');
      if (!store) return;
      await store.append(sessionId, type, payload);
    }
  };
}

async function appendVerificationEvent(session, claim) {
  if (claim.status === 'REJECTED') {
    await session.append('CLAIM_REJECTED', {
      claim: structuredClone(claim)
    });
    return;
  }
  if (['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)) {
    await session.append('CLAIM_VERIFIED', {
      claim: structuredClone(claim)
    });
  }
}

function proposalErrorCode(error) {
  if (typeof error?.code === 'string' && error.code) return error.code;
  if (error instanceof TypeError) return 'INVALID_PROPOSAL';
  return 'PROPOSAL_REJECTED';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalStrings(values) {
  return [...new Set(values.map(String))].sort();
}

function compareUnknown(a, b) {
  return String(a.kind).localeCompare(String(b.kind)) ||
    String(a.ref).localeCompare(String(b.ref));
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
