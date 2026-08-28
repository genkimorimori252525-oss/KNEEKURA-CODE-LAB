import {
  ANALYSIS_REQUEST_SCHEMA,
  validateAnalysisRequestV1
} from '../core/schema/v1.mjs';

import {
  JOLLY_MAILBOX_ANALYSIS_MODES,
  JOLLY_MAILBOX_SERVICE
} from './jolly-research-mailbox.mjs';

export const JOLLY_MAILBOX_CORE_MODE_MAP = Object.freeze({
  architecture: 'UNDERSTAND',
  bug_hunt: 'DIAGNOSE',
  integration: 'UNDERSTAND',
  data_flow: 'TRACE',
  control_flow: 'TRACE',
  performance: 'AUDIT',
  regression: 'DIAGNOSE',
  dead_code: 'AUDIT',
  compare: 'REVIEW',
  general_review: 'REVIEW'
});

const REQUEST_STATUSES = new Set([
  'pending',
  'researching',
  'completed',
  'partial',
  'failed',
  'needs_context'
]);

const ACTIVE_REQUEST_STATUSES = new Set([
  'pending',
  'researching'
]);

const KNOWN_METADATA = new Set([
  'id',
  'status',
  'service',
  'priority',
  'max_output_tokens',
  'source_repository',
  'source_ref',
  'source_commit',
  'source_issue',
  'source_pull_request',
  'project',
  'requested_by',
  'analysis_mode'
]);

const KNOWN_SECTIONS = new Map([
  ['Question', 'question'],
  ['Target paths', 'target_paths'],
  ['Known symptoms / observations', 'known_symptoms'],
  ['Constraints', 'constraints'],
  ['Required output', 'required_output'],
  ['Exclusions', 'exclusions']
]);

export function parseJollyResearchMailboxRequestMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new TypeError('mailbox request markdown must be a non-empty string');
  }

  const lines = markdown
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');

  const metadata = new Map();
  const sections = new Map();
  let currentSection = null;
  let sawDocumentHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^#\s+/.test(line) && !/^##\s+/.test(line)) {
      if (sawDocumentHeading) {
        throw new TypeError(
          'mailbox request markdown must contain only one document heading'
        );
      }
      sawDocumentHeading = true;
      continue;
    }

    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      const title = sectionMatch[1];
      const key = KNOWN_SECTIONS.get(title);
      if (!key) {
        throw new TypeError(
          'unsupported mailbox request section: ' + title
        );
      }
      if (sections.has(key)) {
        throw new TypeError(
          'duplicate mailbox request section: ' + title
        );
      }
      currentSection = key;
      sections.set(key, []);
      continue;
    }

    if (currentSection != null) {
      sections.get(currentSection).push(rawLine);
      continue;
    }

    if (!line.trim()) continue;

    const metadataMatch = line.match(/^([a-z][a-z0-9_]*):(?:\s*(.*))?$/);
    if (!metadataMatch) {
      throw new TypeError(
        'invalid mailbox request metadata line: ' + line
      );
    }

    const key = metadataMatch[1];
    if (!KNOWN_METADATA.has(key)) {
      throw new TypeError(
        'unsupported mailbox request metadata: ' + key
      );
    }
    if (metadata.has(key)) {
      throw new TypeError(
        'duplicate mailbox request metadata: ' + key
      );
    }
    metadata.set(key, metadataMatch[2] ?? '');
  }

  if (!sawDocumentHeading) {
    throw new TypeError(
      'mailbox request markdown requires a document heading'
    );
  }

  const parsed = {
    id: metadata.get('id') ?? '',
    status: metadata.get('status') ?? '',
    service: metadata.get('service') ?? '',
    priority: metadata.get('priority') || 'normal',
    max_output_tokens:
      parsePositiveIntegerOrDefault(
        metadata.get('max_output_tokens'),
        3000,
        'max_output_tokens'
      ),
    source_repository:
      metadata.get('source_repository') ?? '',
    source_ref: metadata.get('source_ref') ?? '',
    source_commit: metadata.get('source_commit') ?? '',
    source_issue: optionalMetadata(metadata, 'source_issue'),
    source_pull_request:
      optionalMetadata(metadata, 'source_pull_request'),
    project: optionalMetadata(metadata, 'project'),
    requested_by: metadata.get('requested_by') ?? '',
    analysis_mode: metadata.get('analysis_mode') ?? '',
    question: paragraphSection(sections.get('question')),
    target_paths: listSection(
      sections.get('target_paths'),
      'Target paths',
      { stripCodeTicks: true }
    ),
    known_symptoms: listSection(
      sections.get('known_symptoms'),
      'Known symptoms / observations'
    ),
    constraints: listSection(
      sections.get('constraints'),
      'Constraints'
    ),
    required_output:
      paragraphSection(sections.get('required_output')),
    exclusions: listSection(
      sections.get('exclusions'),
      'Exclusions'
    )
  };

  validateJollyResearchMailboxRequest(parsed);
  return parsed;
}

export function validateJollyResearchMailboxRequest(
  job,
  { activeOnly = false } = {}
) {
  requireObject(job, 'job');
  requireSingleLine(job.id, 'job.id');

  if (!REQUEST_STATUSES.has(job.status)) {
    throw new TypeError(
      'job.status must be a valid Mailbox request status'
    );
  }
  if (activeOnly && !ACTIVE_REQUEST_STATUSES.has(job.status)) {
    throw new TypeError(
      'job.status must be pending or researching for CORE execution'
    );
  }

  if (job.service !== JOLLY_MAILBOX_SERVICE) {
    throw new TypeError(
      'job.service must be ' + JOLLY_MAILBOX_SERVICE
    );
  }

  requireSingleLine(
    job.source_repository,
    'job.source_repository'
  );
  normalizeSourceRepository(job.source_repository);

  requireSingleLine(job.source_ref, 'job.source_ref');
  requireCommit(job.source_commit, 'job.source_commit');
  requireSingleLine(job.requested_by, 'job.requested_by');

  if (!JOLLY_MAILBOX_ANALYSIS_MODES.includes(job.analysis_mode)) {
    throw new TypeError(
      'job.analysis_mode must be one of ' +
      JOLLY_MAILBOX_ANALYSIS_MODES.join(', ')
    );
  }

  requireText(job.question, 'job.question');

  for (const [key, label] of [
    ['target_paths', 'job.target_paths'],
    ['known_symptoms', 'job.known_symptoms'],
    ['constraints', 'job.constraints'],
    ['exclusions', 'job.exclusions']
  ]) {
    if (job[key] == null) continue;
    requireStringArray(job[key], label);
  }

  for (const targetPath of job.target_paths ?? []) {
    normalizeTargetPath(targetPath);
  }

  if (
    job.max_output_tokens != null &&
    (!Number.isInteger(job.max_output_tokens) ||
      job.max_output_tokens <= 0)
  ) {
    throw new TypeError(
      'job.max_output_tokens must be a positive integer'
    );
  }

  for (const key of [
    'priority',
    'source_issue',
    'source_pull_request',
    'project',
    'required_output'
  ]) {
    if (job[key] != null && job[key] !== '') {
      requireText(job[key], 'job.' + key);
    }
  }

  return job;
}

export function toJollyResearchMailboxCoreExecutionPlan(
  job,
  {
    repository,
    policy = 'balanced',
    outputProfile = 'standard'
  } = {}
) {
  validateJollyResearchMailboxRequest(
    job,
    { activeOnly: true }
  );

  if (
    typeof repository !== 'string' &&
    (repository == null ||
      typeof repository !== 'object' ||
      Array.isArray(repository))
  ) {
    throw new TypeError(
      'repository execution target is required'
    );
  }
  if (
    typeof repository === 'string' &&
    !repository.trim()
  ) {
    throw new TypeError(
      'repository execution target is required'
    );
  }

  const normalizedSourceRepository =
    normalizeSourceRepository(job.source_repository);
  const coreMode =
    JOLLY_MAILBOX_CORE_MODE_MAP[job.analysis_mode];
  if (typeof coreMode !== 'string') {
    throw new TypeError(
      'no frozen CORE v1 mode mapping for Mailbox analysis_mode: ' +
      job.analysis_mode
    );
  }

  const coreRequest = {
    schema: ANALYSIS_REQUEST_SCHEMA,
    repository:
      typeof repository === 'string'
        ? repository
        : structuredClone(repository),
    mode: coreMode,
    question: composeCoreQuestion(job),
    policy,
    snapshot_selector: {
      kind: 'COMMIT',
      commit: job.source_commit
    },
    ...(job.target_paths?.length
      ? {
          scope: {
            paths: job.target_paths.map(normalizeTargetPath)
          }
        }
      : {}),
    output_profile: outputProfile
  };

  validateAnalysisRequestV1(coreRequest);

  return {
    core_request: coreRequest,
    service_result_options: {
      jobId: job.id,
      sourceRepository: normalizedSourceRepository,
      sourceRef: job.source_ref,
      sourceCommit: job.source_commit,
      analysisMode: job.analysis_mode
    },
    output_target: {
      max_output_tokens:
        job.max_output_tokens ?? 3000,
      semantics:
        'soft mailbox result compression target; not a CORE correctness budget'
    },
    mode_mapping: {
      mailbox: job.analysis_mode,
      core: coreMode
    }
  };
}

function composeCoreQuestion(job) {
  const blocks = [job.question.trim()];

  appendCallerList(
    blocks,
    'Caller-known symptoms / observations',
    job.known_symptoms
  );
  appendCallerList(
    blocks,
    'Caller constraints',
    job.constraints
  );
  appendCallerList(
    blocks,
    'Caller exclusions',
    job.exclusions
  );

  return blocks.join('\n\n');
}

function appendCallerList(blocks, heading, values) {
  if (!values?.length) return;
  blocks.push(
    heading + ':\n' +
    values.map(value => '- ' + value.trim()).join('\n')
  );
}

function normalizeSourceRepository(value) {
  const raw = String(value).trim();
  const normalized = raw.replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new TypeError(
      'job.source_repository must be owner/repository'
    );
  }
  return normalized;
}

function normalizeTargetPath(value) {
  requireSingleLine(value, 'job.target_paths[]');
  let normalized = value.trim();

  if (
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^\//.test(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new TypeError(
      'job.target_paths[] must be a repository-relative path'
    );
  }

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized === '.' ||
    segments.some(segment =>
      !segment ||
      segment === '.' ||
      segment === '..'
    )
  ) {
    throw new TypeError(
      'job.target_paths[] must be a normalized repository-relative path'
    );
  }

  if (/[*?\[\]{}]/.test(normalized)) {
    throw new TypeError(
      'job.target_paths[] must be an exact path; CORE v1 scope seeds do not accept globs'
    );
  }

  return normalized;
}

function paragraphSection(lines) {
  return (lines ?? [])
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ');
}

function listSection(
  lines,
  title,
  { stripCodeTicks = false } = {}
) {
  const values = [];
  for (const raw of lines ?? []) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^-\s+(.+)$/);
    if (!match) {
      throw new TypeError(
        title + ' must contain only Markdown list items'
      );
    }
    let value = match[1].trim();
    if (
      stripCodeTicks &&
      value.length >= 2 &&
      value.startsWith('`') &&
      value.endsWith('`') &&
      !value.slice(1, -1).includes('`')
    ) {
      value = value.slice(1, -1);
    }
    values.push(value);
  }
  return values;
}

function optionalMetadata(metadata, key) {
  const value = metadata.get(key);
  return value == null || !value.trim()
    ? null
    : value.trim();
}

function parsePositiveIntegerOrDefault(
  raw,
  fallback,
  name
) {
  if (raw == null || !String(raw).trim()) return fallback;
  const text = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new TypeError(
      name + ' must be a canonical positive base-10 integer'
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      name + ' must be a safe positive base-10 integer'
    );
  }
  return value;
}

function requireObject(value, name) {
  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(name + ' must be an object');
  }
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' must be a non-empty string');
  }
}

function requireSingleLine(value, name) {
  requireText(value, name);
  if (/\r|\n/.test(value)) {
    throw new TypeError(name + ' must be a single line');
  }
}

function requireCommit(value, name) {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  ) {
    throw new TypeError(
      name + ' must be a full SHA-1 or SHA-256 commit id'
    );
  }
}

function requireStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(name + ' must be an array');
  }
  value.forEach((item, index) =>
    requireSingleLine(item, name + '[' + index + ']')
  );
}
