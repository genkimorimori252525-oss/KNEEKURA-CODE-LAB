import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOLLY_MAILBOX_CORE_MODE_MAP,
  parseJollyResearchMailboxRequestMarkdown,
  toJollyResearchMailboxCoreExecutionPlan,
  validateJollyResearchMailboxRequest
} from 'kneekura-code-lab/mailbox';

import {
  validateAnalysisRequestV1
} from '../src/core/schema/v1.mjs';

const COMMIT = 'fda413745216d446dd2400be66b5abfb7ce8b8c0';

const EXAMPLE = `# Example KNEEKURA CODE-LAB Job

id: JOB-20260827-0500-kneekura-shared-node-ownership
status: pending
service: kneekura-code-lab
priority: normal
max_output_tokens: 1800

source_repository: genkimorimori252525-oss/KNEEKURA-CODE-LAB
source_ref: main
source_commit: ${COMMIT}
source_issue:
source_pull_request:
project: KNEEKURA-CODE-LAB
requested_by: codex

analysis_mode: architecture

## Question

Determine whether cross-repository Molang/animation/bone semantic nodes are intentionally shared while implementation nodes remain repository-local, and identify the code boundary that enforces that ownership model.

## Target paths

- \`src/core/workspace.mjs\`

## Known symptoms / observations

- Human-facing documentation says repository-local nodes are namespaced while protocol nodes are shared.

## Constraints

- Do not change the workspace ownership model.
- Do not modify the source repository.

## Required output

Use the KNEEKURA service RESULT contract and identify the enforcing symbol(s).

## Exclusions

- No external web research.
- No viewer/UI analysis.
`;

function job(overrides = {}) {
  return {
    id: 'JOB-20260828-request-plan',
    status: 'pending',
    service: 'kneekura-code-lab',
    priority: 'normal',
    max_output_tokens: 3000,
    source_repository: 'owner/repository',
    source_ref: 'main',
    source_commit: 'a'.repeat(40),
    source_issue: null,
    source_pull_request: null,
    project: 'fixture',
    requested_by: 'codex',
    analysis_mode: 'architecture',
    question: 'Explain the selected boundary.',
    target_paths: ['src/Foo.java'],
    known_symptoms: [],
    constraints: [],
    required_output: '',
    exclusions: [],
    ...overrides
  };
}

test('parses the canonical Mailbox KNEEKURA job shape without losing the commit pin', () => {
  const parsed =
    parseJollyResearchMailboxRequestMarkdown(EXAMPLE);

  assert.equal(
    parsed.id,
    'JOB-20260827-0500-kneekura-shared-node-ownership'
  );
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.source_commit, COMMIT);
  assert.equal(parsed.analysis_mode, 'architecture');
  assert.equal(parsed.max_output_tokens, 1800);
  assert.deepEqual(
    parsed.target_paths,
    ['src/core/workspace.mjs']
  );
  assert.equal(parsed.constraints.length, 2);
  assert.equal(parsed.exclusions.length, 2);
});

test('builds a commit-pinned CORE request while keeping GitHub identity separate from the execution path', () => {
  const parsed =
    parseJollyResearchMailboxRequestMarkdown(EXAMPLE);
  const before = structuredClone(parsed);

  const plan =
    toJollyResearchMailboxCoreExecutionPlan(
      parsed,
      {
        repository: '/workspace/KNEEKURA-CODE-LAB'
      }
    );

  validateAnalysisRequestV1(plan.core_request);
  assert.equal(
    plan.core_request.repository,
    '/workspace/KNEEKURA-CODE-LAB'
  );
  assert.notEqual(
    plan.core_request.repository,
    parsed.source_repository
  );
  assert.equal(plan.core_request.mode, 'UNDERSTAND');
  assert.deepEqual(
    plan.core_request.snapshot_selector,
    {
      kind: 'COMMIT',
      commit: COMMIT
    }
  );
  assert.deepEqual(
    plan.core_request.scope.paths,
    ['src/core/workspace.mjs']
  );
  assert.equal(
    plan.service_result_options.sourceRepository,
    'genkimorimori252525-oss/KNEEKURA-CODE-LAB'
  );
  assert.equal(
    plan.service_result_options.sourceCommit,
    COMMIT
  );
  assert.equal(
    plan.output_target.max_output_tokens,
    1800
  );
  assert.equal(plan.core_request.budget, undefined);
  assert.deepEqual(parsed, before);
});

test('preserves caller observations, constraints, and exclusions as labeled question context', () => {
  const parsed =
    parseJollyResearchMailboxRequestMarkdown(EXAMPLE);
  const plan =
    toJollyResearchMailboxCoreExecutionPlan(
      parsed,
      { repository: '/workspace/repo' }
    );

  assert.match(
    plan.core_request.question,
    /Caller-known symptoms \/ observations:/
  );
  assert.match(
    plan.core_request.question,
    /Caller constraints:/
  );
  assert.match(
    plan.core_request.question,
    /Do not modify the source repository\./
  );
  assert.match(
    plan.core_request.question,
    /Caller exclusions:/
  );
  assert.equal(
    plan.core_request.question.includes(
      'Use the KNEEKURA service RESULT contract'
    ),
    false
  );
});

test('maps every Mailbox analysis mode to a frozen CORE v1 mode', () => {
  assert.deepEqual(
    JOLLY_MAILBOX_CORE_MODE_MAP,
    {
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
    }
  );

  for (const [mailboxMode, coreMode] of
    Object.entries(JOLLY_MAILBOX_CORE_MODE_MAP)) {
    const plan =
      toJollyResearchMailboxCoreExecutionPlan(
        job({ analysis_mode: mailboxMode }),
        { repository: '/workspace/repo' }
      );
    assert.equal(plan.core_request.mode, coreMode);
    assert.equal(
      plan.mode_mapping.mailbox,
      mailboxMode
    );
    assert.equal(plan.mode_mapping.core, coreMode);
  }
});

test('does not reinterpret Mailbox max_output_tokens as a CORE correctness budget', () => {
  const plan =
    toJollyResearchMailboxCoreExecutionPlan(
      job({ max_output_tokens: 777 }),
      { repository: '/workspace/repo' }
    );

  assert.equal(plan.core_request.budget, undefined);
  assert.equal(plan.output_target.max_output_tokens, 777);
  assert.match(
    plan.output_target.semantics,
    /not a CORE correctness budget/
  );
});

test('rejects jobs that are not active or not routed to KNEEKURA', () => {
  assert.throws(
    () => toJollyResearchMailboxCoreExecutionPlan(
      job({ status: 'completed' }),
      { repository: '/workspace/repo' }
    ),
    /pending or researching/
  );

  assert.throws(
    () => validateJollyResearchMailboxRequest(
      job({ service: 'research' })
    ),
    /job\.service/
  );
});

test('rejects an invalid commit pin instead of allowing a workspace fallback', () => {
  assert.throws(
    () => toJollyResearchMailboxCoreExecutionPlan(
      job({ source_commit: 'abc123' }),
      { repository: '/workspace/repo' }
    ),
    /full SHA-1 or SHA-256/
  );
});

test('rejects unsafe or ambiguous target paths before they reach CORE scope planning', () => {
  for (const targetPath of [
    '../secret.txt',
    '/etc/passwd',
    'C:\\repo\\Foo.java',
    'src/**',
    'src//Foo.java'
  ]) {
    assert.throws(
      () => toJollyResearchMailboxCoreExecutionPlan(
        job({ target_paths: [targetPath] }),
        { repository: '/workspace/repo' }
      ),
      /target_paths/
    );
  }
});

test('strict Markdown parsing rejects unknown metadata, sections, and duplicate keys', () => {
  assert.throws(
    () => parseJollyResearchMailboxRequestMarkdown(
      EXAMPLE.replace(
        'priority: normal',
        'priority: normal\nmagic_mode: yes'
      )
    ),
    /unsupported mailbox request metadata/
  );

  assert.throws(
    () => parseJollyResearchMailboxRequestMarkdown(
      EXAMPLE.replace(
        '## Exclusions',
        '## Surprise instructions'
      )
    ),
    /unsupported mailbox request section/
  );

  assert.throws(
    () => parseJollyResearchMailboxRequestMarkdown(
      EXAMPLE.replace(
        'status: pending',
        'status: pending\nstatus: researching'
      )
    ),
    /duplicate mailbox request metadata/
  );
});
