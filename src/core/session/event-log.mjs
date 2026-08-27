import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertCoreOwnedStorage } from '../cache/store.mjs';

export const SESSION_EVENT_SCHEMA = 'core.session-event/v1';
export const SESSION_STATE_SCHEMA = 'core.analysis-session-state/v1';

export const SESSION_EVENT_TYPES = Object.freeze([
  'SESSION_STARTED',
  'SNAPSHOT_FROZEN',
  'SCOPE_DECISION',
  'PROVIDER_STARTED',
  'PROVIDER_COMPLETED',
  'PROVIDER_FAILED',
  'EVIDENCE_STORED',
  'EVIDENCE_REUSED',
  'CLAIM_PROPOSED',
  'CLAIM_VERIFIED',
  'CLAIM_REJECTED',
  'COVERAGE_CHANGED',
  'METRICS_UPDATED',
  'SESSION_FINALIZED'
]);

const EVENT_TYPE_SET = new Set(SESSION_EVENT_TYPES);

export function createSessionStore({
  storageRoot,
  targetRepositoryRoot = null
}) {
  if (!storageRoot) throw new TypeError('storageRoot is required');
  const root = path.resolve(String(storageRoot));
  assertCoreOwnedStorage(root, targetRepositoryRoot);

  return Object.freeze({
    root,

    async startSession({
      sessionId = crypto.randomUUID(),
      parentSessionId = null,
      targetSnapshotId = null,
      normalizedRequest = null,
      engineFingerprint = null,
      ruleFingerprints = []
    } = {}) {
      requireString(sessionId, 'sessionId');
      const dir = sessionDirectory(root, sessionId);
      await fs.mkdir(dir, { recursive: false });
      const eventPath = path.join(dir, 'events.jsonl');
      await fs.writeFile(eventPath, '', { flag: 'wx' });
      await appendEventFile(eventPath, {
        type: 'SESSION_STARTED',
        payload: {
          parent_session_id: parentSessionId,
          target_snapshot_id: targetSnapshotId,
          normalized_request: structuredClone(normalizedRequest),
          engine_fingerprint: engineFingerprint,
          rule_fingerprints: [...new Set(ruleFingerprints.map(String))].sort()
        }
      });
      return { session_id: sessionId, directory: dir };
    },

    async append(sessionId, type, payload = {}) {
      const eventPath = path.join(sessionDirectory(root, sessionId), 'events.jsonl');
      return appendEventFile(eventPath, { type, payload });
    },

    async readEvents(sessionId) {
      const eventPath = path.join(sessionDirectory(root, sessionId), 'events.jsonl');
      const events = await readEventFile(eventPath);
      verifyEventChain(events);
      return events;
    },

    async replay(sessionId) {
      return replaySessionEvents(await this.readEvents(sessionId));
    },

    async writeMaterializedState(sessionId) {
      const state = await this.replay(sessionId);
      const file = path.join(sessionDirectory(root, sessionId), 'state.json');
      await writeJsonAtomic(file, state);
      return state;
    }
  });
}

export function createSessionEvent({
  sequence,
  type,
  payload = {},
  previousDigest = null,
  timestamp = new Date().toISOString()
}) {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new TypeError('session event sequence must be a positive integer');
  }
  if (!EVENT_TYPE_SET.has(type)) {
    throw new TypeError('unsupported session event type: ' + type);
  }
  const body = {
    schema: SESSION_EVENT_SCHEMA,
    sequence,
    type,
    timestamp,
    previous_digest: previousDigest,
    payload: structuredClone(payload)
  };
  return {
    ...body,
    event_digest: digestObject(body)
  };
}

export function verifyEventChain(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  let previous = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event?.schema !== SESSION_EVENT_SCHEMA) {
      throw new Error('invalid session event schema at index ' + index);
    }
    if (event.sequence !== index + 1) {
      throw new Error('session event sequence mismatch at index ' + index);
    }
    if (event.previous_digest !== previous) {
      throw new Error('session event previous digest mismatch at sequence ' + event.sequence);
    }
    const body = {
      schema: event.schema,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      previous_digest: event.previous_digest,
      payload: event.payload
    };
    const expected = digestObject(body);
    if (event.event_digest !== expected) {
      throw new Error('session event digest mismatch at sequence ' + event.sequence);
    }
    previous = event.event_digest;
  }
  return true;
}

export function replaySessionEvents(events) {
  verifyEventChain(events);
  const state = {
    schema: SESSION_STATE_SCHEMA,
    session_id: null,
    parent_session_id: null,
    target_snapshot_id: null,
    normalized_request: null,
    engine_fingerprint: null,
    rule_fingerprints: [],
    snapshot: null,
    scope_decisions: [],
    provider_events: [],
    evidence_ids: [],
    reused_evidence_ids: [],
    invalidated_evidence_ids: [],
    claims: {},
    coverage: null,
    metrics: createSessionMetrics(),
    finalized: false,
    terminal_event_digest: events.at(-1)?.event_digest ?? null
  };

  for (const event of events) {
    applyEvent(state, event);
  }

  state.evidence_ids = [...new Set(state.evidence_ids)].sort();
  state.reused_evidence_ids = [...new Set(state.reused_evidence_ids)].sort();
  state.invalidated_evidence_ids = [...new Set(state.invalidated_evidence_ids)].sort();
  state.rule_fingerprints = [...new Set(state.rule_fingerprints)].sort();
  return state;
}

export function createSessionMetrics() {
  return {
    provider_acquisitions: 0,
    provider_reuse_count: 0,
    evidence_ids_sent_to_reasoning_bridge: 0,
    raw_excerpt_bytes_packed: 0,
    raw_excerpt_tokens_packed: 0,
    cache_hits: 0,
    cache_misses: 0,
    invalidation_reasons: {},
    coverage_expansion_count: 0
  };
}

export function addInvalidationMetric(metrics, reason) {
  const next = structuredClone(metrics ?? createSessionMetrics());
  const key = String(reason || 'UNKNOWN');
  next.invalidation_reasons[key] =
    Number(next.invalidation_reasons[key] ?? 0) + 1;
  return next;
}

function applyEvent(state, event) {
  const payload = event.payload ?? {};

  switch (event.type) {
    case 'SESSION_STARTED':
      state.session_id = String(payload.session_id ?? state.session_id ?? '');
      state.parent_session_id = payload.parent_session_id ?? null;
      state.target_snapshot_id = payload.target_snapshot_id ?? null;
      state.normalized_request = structuredClone(payload.normalized_request ?? null);
      state.engine_fingerprint = payload.engine_fingerprint ?? null;
      state.rule_fingerprints = [...(payload.rule_fingerprints ?? [])];
      break;
    case 'SNAPSHOT_FROZEN':
      state.snapshot = structuredClone(payload.snapshot ?? payload);
      if (payload.snapshot_id) state.target_snapshot_id = payload.snapshot_id;
      if (payload.snapshot?.snapshot_id) state.target_snapshot_id = payload.snapshot.snapshot_id;
      break;
    case 'SCOPE_DECISION':
      state.scope_decisions.push(structuredClone(payload.decision ?? payload));
      break;
    case 'PROVIDER_STARTED':
    case 'PROVIDER_COMPLETED':
    case 'PROVIDER_FAILED':
      state.provider_events.push({
        type: event.type,
        ...structuredClone(payload)
      });
      break;
    case 'EVIDENCE_STORED':
      state.evidence_ids.push(...normalizeIds(payload.evidence_ids ?? payload.evidence_id));
      break;
    case 'EVIDENCE_REUSED':
      {
        const ids = normalizeIds(payload.evidence_ids ?? payload.evidence_id);
        state.evidence_ids.push(...ids);
        state.reused_evidence_ids.push(...ids);
      }
      break;
    case 'CLAIM_PROPOSED':
    case 'CLAIM_VERIFIED':
    case 'CLAIM_REJECTED':
      {
        const claim = payload.claim ?? payload;
        if (claim?.id) state.claims[claim.id] = structuredClone(claim);
      }
      break;
    case 'COVERAGE_CHANGED':
      state.coverage = structuredClone(payload.coverage ?? payload);
      break;
    case 'METRICS_UPDATED':
      state.metrics = mergeMetrics(state.metrics, payload.metrics ?? payload);
      break;
    case 'SESSION_FINALIZED':
      if (payload.coverage) state.coverage = structuredClone(payload.coverage);
      for (const claim of payload.claims ?? []) {
        if (claim?.id) state.claims[claim.id] = structuredClone(claim);
      }
      state.invalidated_evidence_ids.push(
        ...normalizeIds(payload.invalidated_evidence_ids)
      );
      state.finalized = true;
      break;
    default:
      throw new Error('unsupported session event type during replay: ' + event.type);
  }
}

function mergeMetrics(base, update) {
  const next = structuredClone(base ?? createSessionMetrics());
  for (const [key, value] of Object.entries(update ?? {})) {
    if (key === 'invalidation_reasons' && value && typeof value === 'object') {
      for (const [reason, count] of Object.entries(value)) {
        next.invalidation_reasons[reason] =
          Number(next.invalidation_reasons[reason] ?? 0) + Number(count ?? 0);
      }
    } else if (typeof value === 'number') {
      next[key] = Number(next[key] ?? 0) + value;
    }
  }
  return next;
}

async function appendEventFile(eventPath, { type, payload }) {
  const events = await readEventFile(eventPath);
  verifyEventChain(events);
  const event = createSessionEvent({
    sequence: events.length + 1,
    type,
    payload,
    previousDigest: events.at(-1)?.event_digest ?? null
  });
  await fs.appendFile(eventPath, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

async function readEventFile(eventPath) {
  const text = await fs.readFile(eventPath, 'utf8');
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error('invalid session JSONL at line ' + (index + 1) + ': ' + error.message);
      }
    });
}

function sessionDirectory(root, sessionId) {
  requireString(sessionId, 'sessionId');
  const safe = Buffer.from(sessionId).toString('base64url');
  return path.join(root, 'sessions', safe);
}

function normalizeIds(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}

function digestObject(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
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

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}
