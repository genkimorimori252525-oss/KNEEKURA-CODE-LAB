import crypto from 'node:crypto';

export const EVIDENCE_CAPSULE_SCHEMA = 'core.evidence-capsule/v1';

const PROFILE_LIMITS = Object.freeze({
  compact: 12_000,
  standard: 48_000,
  forensic: 196_000
});

export function packEvidenceCapsule({
  request,
  graph,
  planning,
  ledger,
  profile = request?.output_profile ?? 'standard',
  budget = request?.budget ?? {}
}) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Evidence Capsule requires request');
  }
  if (!graph?.nodes || !graph?.edges) {
    throw new TypeError('Evidence Capsule requires graph');
  }
  if (!planning?.scope || !planning?.coverage) {
    throw new TypeError('Evidence Capsule requires deterministic planning');
  }
  if (!ledger?.evidence || !ledger?.claims) {
    throw new TypeError('Evidence Capsule requires Evidence Ledger');
  }
  if (!Object.hasOwn(PROFILE_LIMITS, profile)) {
    throw new TypeError('unsupported Evidence Capsule profile: ' + profile);
  }

  const maxBytes = capsuleByteLimit(profile, budget);
  const selectedItems = planning.scope.items
    .filter(item => item.selected !== false && item.status !== 'UNEXPLORED')
    .slice()
    .sort(compareScopeItems);
  const selectedNodeIds = new Set(
    selectedItems.map(item => item.node_id).filter(Boolean)
  );
  const selectedPaths = new Set(
    selectedItems.map(item => normalizePath(item.path)).filter(Boolean)
  );

  const linkedSupport = new Set();
  const linkedCounter = new Set();
  for (const claim of ledger.claims) {
    for (const link of claim.evidence_links ?? []) {
      if (link.role === 'SUPPORT') linkedSupport.add(link.evidence_id);
    }
    for (const link of claim.counterevidence_links ?? []) {
      if (link.role === 'CONTRADICT') linkedCounter.add(link.evidence_id);
    }
  }

  const rankedEvidence = ledger.evidence
    .map(record => ({
      record,
      rank: evidenceRank(record, {
        linkedSupport,
        linkedCounter,
        selectedPaths,
        request
      })
    }))
    .sort((a, b) =>
      a.rank - b.rank ||
      String(a.record.id).localeCompare(String(b.record.id))
    );

  const matchedRuleIds = new Set(
    (planning.semantic_units?.units ?? [])
      .flatMap(unit => unit.matched_rule_ids ?? [])
  );
  const applicableRules = (planning.rules?.applied ?? [])
    .filter(rule => matchedRuleIds.has(rule.rule_id))
    .map(rule => ({
      rule_id: rule.rule_id,
      version: rule.version,
      rule_hash: rule.rule_hash,
      source_class: rule.source_class,
      trust: rule.trust,
      content_reference: structuredClone(rule.content_reference)
    }))
    .sort((a, b) =>
      a.rule_id.localeCompare(b.rule_id) ||
      a.version.localeCompare(b.version)
    );

  const graphPaths = graph.edges
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

  const base = {
    schema: EVIDENCE_CAPSULE_SCHEMA,
    profile,
    question: request.question,
    mode: request.mode,
    policy: request.policy,
    target_scope: selectedItems.map(item => ({
      id: item.id,
      role: item.role,
      ...(item.node_id ? { node_id: item.node_id } : {}),
      ...(item.path ? { path: normalizePath(item.path) } : {}),
      ...(item.label ? { label: item.label } : {})
    })),
    graph_paths: graphPaths,
    applicable_rules: applicableRules,
    verified_fact_ids: ledger.claims
      .filter(claim =>
        ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status)
      )
      .map(claim => claim.id)
      .sort(),
    coverage: coverageConstraint(planning.coverage),
    unknowns: collectUnknowns(planning.coverage, ledger.claims),
    requested_validation: requestedValidation(request),
    evidence: [],
    source_anchors: [],
    omitted_evidence_ids: [],
    budget: {
      max_bytes: maxBytes,
      packed_bytes: 0,
      estimated_tokens: 0,
      budget_exhausted: false
    }
  };

  const requiredEvidenceIds = new Set([
    ...linkedSupport,
    ...linkedCounter
  ]);
  const envelopeBytes = byteLength(base);
  let usedBytes = envelopeBytes;
  if (envelopeBytes > maxBytes) {
    base.budget.budget_exhausted = true;
  }

  for (const item of rankedEvidence) {
    const packed = {
      id: item.record.id,
      priority: rankName(item.rank),
      record: structuredClone(item.record)
    };
    const packedBytes = byteLength(packed);
    if (usedBytes + packedBytes > maxBytes) {
      base.omitted_evidence_ids.push(item.record.id);
      if (requiredEvidenceIds.has(item.record.id) || item.rank <= 1) {
        base.budget.budget_exhausted = true;
      }
      continue;
    }
    base.evidence.push(packed);
    usedBytes += packedBytes;

    const anchor = sourceAnchor(item.record);
    if (anchor) base.source_anchors.push(anchor);
  }

  base.source_anchors = dedupeObjects(base.source_anchors, anchorKey);
  base.omitted_evidence_ids = [...new Set(base.omitted_evidence_ids)].sort();
  base.budget.packed_bytes = byteLength(base);
  base.budget.estimated_tokens = estimateTokens(base.budget.packed_bytes);

  const excerpts = base.evidence
    .map(item =>
      item.record.observation?.source_excerpt ??
      item.record.observation?.excerpt ??
      null
    )
    .filter(value => typeof value === 'string');
  base.metrics = {
    evidence_record_count: base.evidence.length,
    omitted_evidence_count: base.omitted_evidence_ids.length,
    raw_excerpt_bytes: excerpts.reduce(
      (sum, value) => sum + Buffer.byteLength(value, 'utf8'),
      0
    )
  };
  base.metrics.raw_excerpt_tokens = estimateTokens(
    base.metrics.raw_excerpt_bytes
  );

  base.fingerprint = digestObject({
    profile: base.profile,
    question: base.question,
    mode: base.mode,
    policy: base.policy,
    target_scope: base.target_scope,
    graph_paths: base.graph_paths,
    applicable_rules: base.applicable_rules,
    verified_fact_ids: base.verified_fact_ids,
    coverage: base.coverage,
    unknowns: base.unknowns,
    evidence_ids: base.evidence.map(item => item.id),
    omitted_evidence_ids: base.omitted_evidence_ids,
    budget_exhausted: base.budget.budget_exhausted
  });

  base.budget.packed_bytes = byteLength(base);
  base.budget.estimated_tokens = estimateTokens(base.budget.packed_bytes);
  if (base.budget.packed_bytes > maxBytes) {
    base.budget.budget_exhausted = true;
    base.fingerprint = digestObject({
      profile: base.profile,
      question: base.question,
      mode: base.mode,
      policy: base.policy,
      target_scope: base.target_scope,
      graph_paths: base.graph_paths,
      applicable_rules: base.applicable_rules,
      verified_fact_ids: base.verified_fact_ids,
      coverage: base.coverage,
      unknowns: base.unknowns,
      evidence_ids: base.evidence.map(item => item.id),
      omitted_evidence_ids: base.omitted_evidence_ids,
      budget_exhausted: true
    });
  }
  return base;
}

export function capsuleByteLimit(profile, budget = {}) {
  const candidates = [PROFILE_LIMITS[profile]];
  if (Number.isFinite(budget.capsule_bytes) && budget.capsule_bytes >= 0) {
    candidates.push(Math.floor(budget.capsule_bytes));
  }
  if (Number.isFinite(budget.capsule_tokens) && budget.capsule_tokens >= 0) {
    candidates.push(Math.floor(budget.capsule_tokens * 4));
  }
  return Math.max(0, Math.min(...candidates));
}

export function estimateTokens(bytes) {
  return Math.ceil(Math.max(0, Number(bytes) || 0) / 4);
}

function evidenceRank(record, {
  linkedSupport,
  linkedCounter,
  selectedPaths,
  request
}) {
  if (linkedSupport.has(record.id)) return 0;
  if (linkedCounter.has(record.id)) return 1;
  const path = normalizePath(record.provenance?.path);
  if (path && selectedPaths.has(path)) return 2;
  if (
    ['TRACE','DIAGNOSE','RUNTIME'].includes(request.mode) &&
    record.kind === 'RUNTIME'
  ) {
    return 3;
  }
  return 4;
}

function rankName(rank) {
  return [
    'DIRECT_EVIDENCE',
    'COUNTEREVIDENCE',
    'SCOPE_EVIDENCE',
    'RUNTIME_CONTEXT',
    'SUPPORTING_CONTEXT'
  ][rank] ?? 'SUPPORTING_CONTEXT';
}

function coverageConstraint(coverage) {
  return {
    schema: coverage.schema,
    completeness: coverage.completeness,
    snapshot_id: coverage.snapshot_id ?? null,
    fingerprint: coverage.fingerprint ?? null,
    closure: structuredClone(coverage.closure ?? null),
    gaps: coverage.entries
      .filter(entry => ['FAILED','UNEXPLORED'].includes(entry.status))
      .map(entry => ({
        id: entry.id,
        status: entry.status,
        reason: entry.reason,
        reason_code: entry.reason_code ?? null
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

function collectUnknowns(coverage, claims) {
  const rows = coverage.entries
    .filter(entry => ['FAILED','UNEXPLORED'].includes(entry.status))
    .map(entry => ({
      kind: 'COVERAGE',
      ref: entry.id,
      reason: entry.reason,
      reason_code: entry.reason_code ?? null
    }));

  for (const claim of claims) {
    if (claim.status !== 'UNRESOLVED') continue;
    rows.push({
      kind: 'CLAIM',
      ref: claim.id,
      reason:
        claim.unresolved_reason ??
        'claim remains unresolved after deterministic verification'
    });
  }
  return rows.sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind)) ||
    String(a.ref).localeCompare(String(b.ref))
  );
}

function requestedValidation(request) {
  if (request.mode === 'TRACE' || request.mode === 'RUNTIME') {
    return ['preserve runtime/static stage boundaries'];
  }
  if (request.mode === 'DIAGNOSE') {
    return ['preserve counterevidence and unresolved alternatives'];
  }
  if (request.mode === 'AUDIT') {
    return ['do not promote absence without complete negative-search authority'];
  }
  return ['preserve Coverage and UNKNOWN qualifiers'];
}

function sourceAnchor(record) {
  const provenance = record.provenance ?? {};
  if (
    !provenance.path &&
    !provenance.symbol_id &&
    !provenance.artifact_id &&
    !provenance.runtime_run_id
  ) {
    return null;
  }
  return {
    evidence_id: record.id,
    ...(provenance.path ? {
      path: normalizePath(provenance.path)
    } : {}),
    ...(provenance.range ? {
      range: structuredClone(provenance.range)
    } : {}),
    ...(provenance.symbol_id ? {
      symbol_id: provenance.symbol_id
    } : {}),
    ...(provenance.artifact_id ? {
      artifact_id: provenance.artifact_id
    } : {}),
    ...(provenance.runtime_run_id ? {
      runtime_run_id: provenance.runtime_run_id
    } : {})
  };
}

function compareScopeItems(a, b) {
  return roleRank(a.role) - roleRank(b.role) ||
    String(a.id).localeCompare(String(b.id));
}

function roleRank(role) {
  return {
    PRIMARY: 0,
    RUNTIME_ARTIFACT: 0,
    DEPENDENCY: 1,
    SUPPORTING_CONTEXT: 2
  }[role] ?? 3;
}

function normalizePath(value) {
  if (value == null) return null;
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function dedupeObjects(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, value);
  }
  return [...map.values()].sort((a, b) =>
    keyFn(a).localeCompare(keyFn(b))
  );
}

function anchorKey(value) {
  return [
    value.evidence_id,
    value.path ?? '',
    value.symbol_id ?? '',
    value.artifact_id ?? '',
    value.runtime_run_id ?? '',
    JSON.stringify(value.range ?? null)
  ].join('\0');
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
