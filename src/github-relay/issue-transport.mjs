import crypto from 'node:crypto';

import {
  ALL_CHILD_BINDING_SCHEMA,
  ALL_CONTEXT_ASSURANCE_CLASS,
  ALL_CONTEXT_CLAIM_SCHEMA
} from './all-mode-contracts.mjs';
import {
  GITHUB_RELAY_SCHEMAS,
  stableRelayJson,
  validateRelayPlan,
  validateRelayRequest,
  validateRelayResponseEnvelope,
  validateRelaySourceRequest
} from './contracts.mjs';

export const GITHUB_RELAY_MARKERS = Object.freeze({
  request: 'KNEEKURA_RELAY_REQUEST_V1',
  plan: 'KNEEKURA_RELAY_PLAN_V1',
  task: 'KNEEKURA_RELAY_TASK_V1',
  response: 'KNEEKURA_RELAY_RESPONSE_V1',
  sourceRequest: 'KNEEKURA_RELAY_SOURCE_REQUEST_V1',
  sourceResult: 'KNEEKURA_RELAY_SOURCE_RESULT_V1',
  result: 'KNEEKURA_RELAY_RESULT_V1',
  allContextClaim: 'KNEEKURA_RELAY_CONTEXT_CLAIM_V1',
  allResume: 'KNEEKURA_RELAY_ALL_RESUME_V1',
  allChildBinding: 'KNEEKURA_RELAY_ALL_CHILD_BINDING_V1',
  error: 'KNEEKURA_RELAY_ERROR_V1'
});

export const GITHUB_RELAY_COMMENT_MAX_BYTES = 60 * 1024;

const ALL_RESUME_SCHEMA = 'kneekura.code-lab.github-relay-all-resume/v1';
const CLIENT_MARKERS = new Map([
  [GITHUB_RELAY_MARKERS.response, 'response'],
  [GITHUB_RELAY_MARKERS.sourceRequest, 'sourceRequest'],
  [GITHUB_RELAY_MARKERS.allContextClaim, 'contextClaim'],
  [GITHUB_RELAY_MARKERS.allResume, 'allResume']
]);
const BOT_MARKERS = new Map([
  [GITHUB_RELAY_MARKERS.plan, 'plan'],
  [GITHUB_RELAY_MARKERS.task, 'task'],
  [GITHUB_RELAY_MARKERS.sourceResult, 'sourceResult'],
  [GITHUB_RELAY_MARKERS.result, 'result'],
  [GITHUB_RELAY_MARKERS.allChildBinding, 'allChildBinding'],
  [GITHUB_RELAY_MARKERS.error, 'error']
]);
const ALL_MARKERS = new Set([
  GITHUB_RELAY_MARKERS.request,
  ...CLIENT_MARKERS.keys(),
  ...BOT_MARKERS.keys()
]);

const ALL_ENGINE_BY_SLOT = Object.freeze([
  'kneekura',
  'understand-anything',
  'archify'
]);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function parseRelayIssueRequest(issue, { allowedActors } = {}) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    throw new TypeError('relay issue must be an object');
  }
  if (issue.pull_request) {
    throw codedError('RELAY_PULL_REQUEST_THREAD_FORBIDDEN', 'GitHub Relay runs require a real Issue, not a pull request thread');
  }
  const actors = normalizeActorSet(allowedActors);
  const author = normalizeActor(issue.user?.login);
  if (!actors.has(author)) {
    throw codedError('RELAY_ISSUE_AUTHOR_NOT_ALLOWED', 'relay Issue author is not authorized');
  }
  const value = parseExactMarkedJson(issue.body, GITHUB_RELAY_MARKERS.request);
  return validateRelayRequest(value);
}

export function parseRelayThreadComments(comments, {
  allowedActors,
  botActors = ['github-actions[bot]']
} = {}) {
  if (!Array.isArray(comments)) throw new TypeError('relay comments must be an array');
  const clients = normalizeActorSet(allowedActors);
  const bots = normalizeActorSet(botActors);
  const out = {
    responses: [],
    sourceRequests: [],
    contextClaims: [],
    allResumes: [],
    plans: [],
    tasks: [],
    sourceResults: [],
    results: [],
    allChildBindings: [],
    errors: []
  };

  for (const comment of comments) {
    if (!comment || typeof comment !== 'object') continue;
    const body = String(comment.body ?? '');
    const marker = recognizedMarker(body);
    if (!marker) continue;
    const actor = normalizeActor(comment.user?.login);
    const commentId = normalizeCommentId(comment.id);

    const clientKind = CLIENT_MARKERS.get(marker);
    if (clientKind) {
      if (!clients.has(actor)) continue;
      const parsed = parseExactMarkedJson(body, marker);
      let envelope;
      let bucket;
      if (clientKind === 'response') {
        envelope = validateRelayResponseEnvelope(parsed);
        bucket = 'responses';
      } else if (clientKind === 'sourceRequest') {
        envelope = validateRelaySourceRequest(parsed);
        bucket = 'sourceRequests';
      } else if (clientKind === 'contextClaim') {
        envelope = validateAllContextClaimTransport(parsed);
        bucket = 'contextClaims';
      } else {
        envelope = validateAllResumeTransport(parsed);
        bucket = 'allResumes';
      }
      out[bucket].push({ comment_id: commentId, actor, envelope });
      continue;
    }

    const botKind = BOT_MARKERS.get(marker);
    if (!botKind || !bots.has(actor)) continue;
    const parsed = parseExactMarkedJson(body, marker);
    if (botKind === 'plan') {
      out.plans.push({ comment_id: commentId, actor, envelope: validateRelayPlan(parsed) });
      continue;
    }
    if (botKind === 'allChildBinding') {
      out.allChildBindings.push({
        comment_id: commentId,
        actor,
        envelope: validateAllChildBindingTransport(parsed)
      });
      continue;
    }
    assertBotEnvelopeSchema(parsed, botKind);
    out[botKind === 'sourceResult' ? 'sourceResults' : `${botKind}s`].push({
      comment_id: commentId,
      actor,
      envelope: parsed
    });
  }

  for (const values of Object.values(out)) {
    values.sort((a, b) => a.comment_id - b.comment_id);
  }
  return deepFreeze(out);
}

export function selectCanonicalRelayPlan(planEntries) {
  if (!Array.isArray(planEntries) || planEntries.length === 0) return null;
  const first = planEntries[0].envelope;
  const canonical = stableRelayJson(first);
  for (const entry of planEntries.slice(1)) {
    if (stableRelayJson(entry.envelope) !== canonical) {
      throw codedError('RELAY_PLAN_CONFLICT', 'Issue contains conflicting runner-authored relay plans');
    }
  }
  return first;
}

export function relayTaskIds(taskEntries) {
  const ids = new Set();
  for (const entry of taskEntries ?? []) {
    const taskId = String(entry?.envelope?.task?.task_id ?? '').trim().toLowerCase();
    if (/^task:sha256:[0-9a-f]{64}$/.test(taskId)) ids.add(taskId);
  }
  return ids;
}

export function relaySourceResultDigests(entries) {
  const digests = new Set();
  for (const entry of entries ?? []) {
    const digest = String(entry?.envelope?.source_request_digest ?? '').trim().toLowerCase();
    if (/^sha256:[0-9a-f]{64}$/.test(digest)) digests.add(digest);
  }
  return digests;
}

export function relayResultRunIds(entries) {
  const ids = new Set();
  for (const entry of entries ?? []) {
    const runId = String(entry?.envelope?.run_id ?? '').trim();
    if (runId) ids.add(runId);
  }
  return ids;
}

export function relayEnvelopeDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableRelayJson(value)).digest('hex')}`;
}

export function renderRelayComment(marker, value, {
  maxBytes = GITHUB_RELAY_COMMENT_MAX_BYTES
} = {}) {
  if (!ALL_MARKERS.has(marker)) throw new TypeError(`unknown relay marker: ${marker}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('relay comment maxBytes must be an integer >= 1024');
  }
  const json = JSON.stringify(value, null, 2);
  if (typeof json !== 'string') throw new TypeError('relay comment value must be JSON serializable');
  const body = `${marker}\n\n\`\`\`json\n${json}\n\`\`\``;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) {
    throw codedError(
      'BLOCKED_RELAY_COMMENT_BUDGET',
      `relay comment requires ${bytes} bytes, exceeding the ${maxBytes}-byte transport budget`
    );
  }
  return body;
}

export function parseExactMarkedJson(body, marker) {
  if (!ALL_MARKERS.has(marker)) throw new TypeError(`unknown relay marker: ${marker}`);
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  const prefix = `${marker}\n\n\`\`\`json\n`;
  const suffix = '\n```';
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    throw codedError('RELAY_MESSAGE_FORMAT_INVALID', `relay message must contain only ${marker} and one fenced JSON object`);
  }
  const raw = text.slice(prefix.length, -suffix.length);
  if (raw.includes(`\n${marker}\n`) || raw.startsWith(marker)) {
    throw codedError('RELAY_MESSAGE_FORMAT_INVALID', 'relay message marker is duplicated');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw codedError('RELAY_MESSAGE_JSON_INVALID', `relay JSON is invalid: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codedError('RELAY_MESSAGE_JSON_INVALID', 'relay message JSON must be an object');
  }
  return parsed;
}

export function recognizedRelayClientMarker(body) {
  const marker = recognizedMarker(String(body ?? ''));
  return marker && CLIENT_MARKERS.has(marker) ? marker : null;
}

function recognizedMarker(body) {
  const firstLine = String(body ?? '').replace(/\r\n?/g, '\n').trimStart().split('\n', 1)[0].trim();
  return ALL_MARKERS.has(firstLine) ? firstLine : null;
}

function validateAllContextClaimTransport(value) {
  assertRecord(value, 'ALL context claim');
  assertOnlyKeys(value, [
    'schema',
    'parent_run_id',
    'parent_issue_number',
    'child_issue_number',
    'engine_id',
    'host_context_id',
    'assurance_class'
  ], 'ALL context claim');
  if (value.schema !== ALL_CONTEXT_CLAIM_SCHEMA) {
    throw new TypeError(`ALL context claim schema must be ${ALL_CONTEXT_CLAIM_SCHEMA}`);
  }
  const runId = boundedText(value.parent_run_id, 'parent_run_id', 128);
  if (!SAFE_RUN_ID.test(runId)) throw new TypeError('parent_run_id is invalid');
  const assurance = String(value.assurance_class ?? '');
  if (assurance !== ALL_CONTEXT_ASSURANCE_CLASS) {
    throw codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', 'ALL context claim assurance class is not accepted');
  }
  return deepFreeze({
    schema: ALL_CONTEXT_CLAIM_SCHEMA,
    parent_run_id: runId,
    parent_issue_number: positiveInteger(value.parent_issue_number, 'parent_issue_number'),
    child_issue_number: positiveInteger(value.child_issue_number, 'child_issue_number'),
    engine_id: normalizeAllEngine(value.engine_id),
    host_context_id: boundedText(value.host_context_id, 'host_context_id', 512),
    assurance_class: assurance
  });
}

function validateAllResumeTransport(value) {
  assertRecord(value, 'ALL resume');
  assertOnlyKeys(value, ['schema', 'parent_run_id', 'parent_issue_number'], 'ALL resume');
  if (value.schema !== ALL_RESUME_SCHEMA) {
    throw new TypeError(`ALL resume schema must be ${ALL_RESUME_SCHEMA}`);
  }
  const runId = boundedText(value.parent_run_id, 'parent_run_id', 128);
  if (!SAFE_RUN_ID.test(runId)) throw new TypeError('parent_run_id is invalid');
  return deepFreeze({
    schema: ALL_RESUME_SCHEMA,
    parent_run_id: runId,
    parent_issue_number: positiveInteger(value.parent_issue_number, 'parent_issue_number')
  });
}

function validateAllChildBindingTransport(value) {
  assertRecord(value, 'ALL child binding');
  assertOnlyKeys(value, [
    'schema',
    'parent_run_id',
    'parent_issue_number',
    'child_issue_number',
    'child_slot',
    'engine_id',
    'target',
    'scope_digest',
    'code_lab_revision',
    'engine_lock_digest',
    'child_request_digest'
  ], 'ALL child binding');
  if (value.schema !== ALL_CHILD_BINDING_SCHEMA) {
    throw new TypeError(`ALL child binding schema must be ${ALL_CHILD_BINDING_SCHEMA}`);
  }
  const slot = positiveInteger(value.child_slot, 'child_slot');
  if (slot > ALL_ENGINE_BY_SLOT.length) throw new TypeError('child_slot is outside the fixed ALL engine set');
  const engineId = normalizeAllEngine(value.engine_id);
  if (ALL_ENGINE_BY_SLOT[slot - 1] !== engineId) {
    throw codedError('ALL_CHILD_BINDING_MISMATCH', 'ALL child engine does not match its fixed child slot');
  }
  const plan = validateRelayPlan({
    schema: GITHUB_RELAY_SCHEMAS.plan,
    run_id: value.parent_run_id,
    selection: 'all',
    target: value.target,
    semantic_context_mode: 'per-engine',
    code_lab_revision: value.code_lab_revision,
    engine_lock_digest: value.engine_lock_digest
  });
  const scopeDigest = normalizeDigest(value.scope_digest, 'scope_digest');
  if (scopeDigest !== plan.target.scope_digest) {
    throw codedError('ALL_CHILD_BINDING_MISMATCH', 'ALL child scope digest does not match its parent target scope');
  }
  return deepFreeze({
    schema: ALL_CHILD_BINDING_SCHEMA,
    parent_run_id: plan.run_id,
    parent_issue_number: positiveInteger(value.parent_issue_number, 'parent_issue_number'),
    child_issue_number: positiveInteger(value.child_issue_number, 'child_issue_number'),
    child_slot: slot,
    engine_id: engineId,
    target: plan.target,
    scope_digest: scopeDigest,
    code_lab_revision: plan.code_lab_revision,
    engine_lock_digest: plan.engine_lock_digest,
    child_request_digest: normalizeDigest(value.child_request_digest, 'child_request_digest')
  });
}

function assertBotEnvelopeSchema(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`relay ${kind} envelope must be an object`);
  }
  const expected = kind === 'task'
    ? GITHUB_RELAY_SCHEMAS.task
    : kind === 'sourceResult'
      ? GITHUB_RELAY_SCHEMAS.sourceResult
      : kind === 'result'
        ? GITHUB_RELAY_SCHEMAS.result
        : 'kneekura.code-lab.github-relay-error/v1';
  if (value.schema !== expected) {
    throw codedError('RELAY_BOT_ENVELOPE_INVALID', `relay ${kind} schema must be ${expected}`);
  }
}

function normalizeActorSet(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const set = new Set(list.map(normalizeActor).filter(Boolean));
  if (set.size === 0) throw new TypeError('at least one relay actor must be authorized');
  return set;
}

function normalizeActor(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeCommentId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('relay comment id must be a positive safe integer');
  return id;
}

function normalizeAllEngine(value) {
  const engineId = String(value ?? '');
  if (!ALL_ENGINE_BY_SLOT.includes(engineId)) throw new TypeError(`unsupported ALL engine: ${engineId}`);
  return engineId;
}

function normalizeDigest(value, label) {
  const digest = String(value ?? '').trim().toLowerCase();
  if (!SHA256_DIGEST.test(digest)) throw new TypeError(`${label} must be sha256:<64 hex>`);
  return digest;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function boundedText(value, label, maxBytes) {
  const text = String(value ?? '').trim();
  if (!text || CONTROL_CHARACTERS.test(text)) throw new TypeError(`${label} is invalid`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  return text;
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertOnlyKeys(value, allowed, label) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${label} contains unsupported key: ${key}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}