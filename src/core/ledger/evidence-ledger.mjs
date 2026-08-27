import crypto from 'node:crypto';
import {
  validateClaimRecordV1,
  validateCoverageManifestV1,
  validateEvidenceRecordV1
} from '../schema/v1.mjs';
import { validateVerificationRecord } from '../verification/record.mjs';

export const EVIDENCE_LEDGER_SCHEMA = 'core.evidence-ledger/v1';

export function createEvidenceLedger({
  repositoryIds = [],
  snapshotIds = [],
  coverage
}) {
  if (coverage) validateCoverageManifestV1(coverage);
  return {
    schema: EVIDENCE_LEDGER_SCHEMA,
    repository_ids: [...new Set(repositoryIds)].sort(),
    snapshot_ids: [...new Set(snapshotIds)].sort(),
    coverage: coverage ? structuredClone(coverage) : null,
    coverage_ref: coverage ? coverageReference(coverage) : null,
    evidence: [],
    claims: [],
    verification_records: []
  };
}

export function createEvidenceLedgerFromGraph(graph, coverage) {
  if (!graph || typeof graph !== 'object') throw new TypeError('graph is required');
  const repositoryIds = new Set();
  const snapshotIds = new Set();

  if (graph.meta?.repository?.repository_id) repositoryIds.add(graph.meta.repository.repository_id);
  if (graph.meta?.snapshot?.snapshot_id) snapshotIds.add(graph.meta.snapshot.snapshot_id);

  for (const constituent of graph.meta?.snapshot?.constituents ?? []) {
    if (constituent.repository_id) repositoryIds.add(constituent.repository_id);
    if (constituent.snapshot_id) snapshotIds.add(constituent.snapshot_id);
  }
  for (const entry of graph.meta?.repositories ?? []) {
    if (entry.repository?.repository_id) repositoryIds.add(entry.repository.repository_id);
    if (entry.snapshot?.snapshot_id) snapshotIds.add(entry.snapshot.snapshot_id);
  }

  const ledger = createEvidenceLedger({
    repositoryIds: [...repositoryIds],
    snapshotIds: [...snapshotIds],
    coverage
  });

  storeEvidence(ledger, graph.meta?.evidence ?? []);
  return ledger;
}

export function storeEvidence(ledger, records) {
  assertLedger(ledger);
  const input = Array.isArray(records) ? records : [records];
  const stored = [];
  const byDedupKey = new Map(
    ledger.evidence.map(item => [evidenceDedupKey(item), item])
  );
  const byId = new Map(ledger.evidence.map(item => [item.id, item]));

  for (const record of input) {
    validateEvidenceRecordV1(record);
    assertEvidenceIntegrity(record);
    const key = evidenceDedupKey(record);
    const duplicate = byDedupKey.get(key);
    if (duplicate) {
      stored.push({ id: duplicate.id, reused: true });
      continue;
    }

    if (byId.has(record.id)) {
      throw new Error('evidence id collision with different content: ' + record.id);
    }

    const frozen = deepFreeze(structuredClone(record));
    ledger.evidence.push(frozen);
    byDedupKey.set(key, frozen);
    byId.set(frozen.id, frozen);
    stored.push({ id: frozen.id, reused: false });
  }

  ledger.evidence.sort((a, b) => a.id.localeCompare(b.id));
  return stored;
}

export function getEvidence(ledger, evidenceId) {
  assertLedger(ledger);
  return ledger.evidence.find(item => item.id === evidenceId) ?? null;
}

export function addClaim(ledger, claim) {
  assertLedger(ledger);
  validateClaimRecordV1(claim);
  assertClaimIngressState(claim);
  assertClaimEvidenceRefsExist(ledger, claim);

  if (ledger.claims.some(existing => existing.id === claim.id)) {
    throw new Error('claim already exists: ' + claim.id);
  }

  ledger.claims.push(deepFreeze(structuredClone(claim)));
  ledger.claims.sort((a, b) => a.id.localeCompare(b.id));
  return claim.id;
}

export function replaceClaim(ledger, claim) {
  assertLedger(ledger);
  validateClaimRecordV1(claim);
  assertVerifiedStateHasMachineRecords(ledger, claim);
  assertClaimEvidenceRefsExist(ledger, claim);

  const index = ledger.claims.findIndex(existing => existing.id === claim.id);
  if (index < 0) throw new Error('claim not found: ' + claim.id);
  ledger.claims[index] = deepFreeze(structuredClone(claim));
  ledger.claims.sort((a, b) => a.id.localeCompare(b.id));
  return claim.id;
}

export function addVerificationRecord(ledger, record) {
  assertLedger(ledger);
  validateVerificationRecord(record);

  const existing = ledger.verification_records.find(item => item.id === record.id);
  if (existing) {
    if (stableStringify(existing) !== stableStringify(record)) {
      throw new Error('verification record id collision: ' + record.id);
    }
    return record.id;
  }

  ledger.verification_records.push(deepFreeze(structuredClone(record)));
  ledger.verification_records.sort((a, b) => a.id.localeCompare(b.id));
  return record.id;
}

export function finalizeEvidenceLedger(ledger) {
  assertLedger(ledger);
  if (ledger.coverage) validateCoverageManifestV1(ledger.coverage);
  ledger.evidence.forEach(record => validateEvidenceRecordV1(record));
  ledger.claims.forEach(claim => {
    validateClaimRecordV1(claim);
    assertClaimEvidenceRefsExist(ledger, claim);
  });

  const snapshot = {
    schema: ledger.schema,
    repository_ids: [...ledger.repository_ids].sort(),
    snapshot_ids: [...ledger.snapshot_ids].sort(),
    coverage: ledger.coverage ? structuredClone(ledger.coverage) : null,
    coverage_ref: ledger.coverage_ref,
    evidence: ledger.evidence.map(item => structuredClone(item)),
    claims: ledger.claims.map(item => structuredClone(item)),
    claim_evidence_links: flattenClaimEvidenceLinks(ledger.claims),
    verification_records: ledger.verification_records.map(item => structuredClone(item))
  };
  snapshot.fingerprint = digestObject({
    repository_ids: snapshot.repository_ids,
    snapshot_ids: snapshot.snapshot_ids,
    coverage_ref: snapshot.coverage_ref,
    evidence: snapshot.evidence.map(item => [item.id, item.integrity_digest]),
    claims: snapshot.claims,
    verification_records: snapshot.verification_records
  });
  return snapshot;
}

export function reconstructConclusions(ledger) {
  assertLedger(ledger);
  return ledger.claims
    .filter(claim => ['VERIFIED','VERIFIED_WITH_LIMITS'].includes(claim.status))
    .map(item => structuredClone(item))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function coverageReference(coverage) {
  if (!coverage) return 'coverage:none';
  if (typeof coverage.fingerprint === 'string' && coverage.fingerprint) {
    return 'coverage:' + coverage.fingerprint;
  }
  return 'coverage:' + digestObject({
    schema: coverage.schema,
    completeness: coverage.completeness,
    entries: coverage.entries
  });
}

export function evidenceDedupKey(record) {
  validateEvidenceRecordV1(record);
  return digestObject({
    kind: record.kind,
    observation: record.observation,
    provenance: {
      repository_id: record.provenance.repository_id,
      snapshot_id: record.provenance.snapshot_id,
      provider_id: record.provenance.provider_id,
      provider_version: record.provenance.provider_version,
      extraction_method: record.provenance.extraction_method,
      artifact_id: record.provenance.artifact_id ?? null,
      artifact_digest: record.provenance.artifact_digest ?? null,
      git_object_id: record.provenance.git_object_id ?? null,
      runtime_run_id: record.provenance.runtime_run_id ?? null,
      path: record.provenance.path ?? null,
      symbol_id: record.provenance.symbol_id ?? null,
      range: record.provenance.range ?? null
    },
    trust_class: record.trust_class,
    provider_id: record.provider_id,
    provider_version: record.provider_version
  });
}

function assertEvidenceIntegrity(record) {
  const basis = {
    schema: record.schema,
    kind: record.kind,
    observation: record.observation,
    provenance: record.provenance,
    trust_class: record.trust_class,
    provider_id: record.provider_id,
    provider_version: record.provider_version
  };
  const expectedIntegrity = digestObject(basis);
  if (record.integrity_digest !== expectedIntegrity) {
    throw new Error('evidence integrity digest mismatch: ' + record.id);
  }

  const identityDigest = digestObject({
    ...basis,
    integrity_digest: expectedIntegrity
  }).slice('sha256:'.length);
  const expectedId = 'evidence:sha256:' + identityDigest;
  if (record.id !== expectedId) {
    throw new Error('evidence id does not match content-derived identity: ' + record.id);
  }
}

function findEquivalentEvidence(ledger, record) {
  const key = evidenceDedupKey(record);
  return ledger.evidence.find(existing => evidenceDedupKey(existing) === key) ?? null;
}

function assertClaimIngressState(claim) {
  if (claim.type === 'UNKNOWN') {
    if (claim.status !== 'UNRESOLVED') {
      throw new Error('UNKNOWN claim ingress must be UNRESOLVED');
    }
    return;
  }
  if (claim.status !== 'PROPOSED') {
    throw new Error('claim ingress must be PROPOSED before deterministic verification');
  }
}

function assertVerifiedStateHasMachineRecords(ledger, claim) {
  if (!['VERIFIED','VERIFIED_WITH_LIMITS','REJECTED'].includes(claim.status)) return;

  if (!Array.isArray(claim.verifier_results) || claim.verifier_results.length === 0) {
    throw new Error('verified/rejected claim state requires machine verifier_results');
  }

  const registered = new Set(ledger.verification_records.map(record => record.id));
  for (const record of claim.verifier_results) {
    validateVerificationRecord(record);
    if (!registered.has(record.id)) {
      throw new Error('claim references unregistered machine verifier result: ' + record.id);
    }
  }
}

function assertClaimEvidenceRefsExist(ledger, claim) {
  const ids = new Set(ledger.evidence.map(item => item.id));
  for (const link of [...claim.evidence_links, ...claim.counterevidence_links]) {
    if (!ids.has(link.evidence_id)) {
      throw new Error('claim references missing evidence: ' + link.evidence_id);
    }
  }
}

function flattenClaimEvidenceLinks(claims) {
  const rows = [];
  for (const claim of claims) {
    for (const link of claim.evidence_links) {
      rows.push({ claim_id: claim.id, ...structuredClone(link) });
    }
    for (const link of claim.counterevidence_links) {
      rows.push({ claim_id: claim.id, ...structuredClone(link) });
    }
  }
  return rows.sort((a, b) =>
    a.claim_id.localeCompare(b.claim_id) ||
    a.evidence_id.localeCompare(b.evidence_id) ||
    a.role.localeCompare(b.role)
  );
}

function assertLedger(ledger) {
  if (!ledger || ledger.schema !== EVIDENCE_LEDGER_SCHEMA) {
    throw new TypeError('core.evidence-ledger/v1 is required');
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
