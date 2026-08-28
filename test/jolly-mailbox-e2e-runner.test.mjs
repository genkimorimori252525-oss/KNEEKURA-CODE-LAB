import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  runJollyResearchMailboxRequest
} from 'kneekura-code-lab/mailbox';

import {
  createCoreEngine
} from 'kneekura-code-lab/plugin';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  return stdout.trim();
}

async function createMailboxRepository(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-mailbox-e2e-repo-')
  );
  const tempParent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kneekura-mailbox-e2e-temp-')
  );

  t.after(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true
    });
    await fs.rm(tempParent, {
      recursive: true,
      force: true
    });
  });

  await git(root, ['init']);
  await git(root, [
    'config',
    'user.email',
    'fixture@example.invalid'
  ]);
  await git(root, [
    'config',
    'user.name',
    'Fixture'
  ]);
  await git(root, [
    'remote',
    'add',
    'origin',
    'https://github.com/e2e-fixture/mailbox-target.git'
  ]);

  const source = path.join(root, 'src', 'Versioned.java');
  await fs.mkdir(path.dirname(source), {
    recursive: true
  });

  const committedSource = [
    'package demo;',
    'public class CommittedVersion {',
    '  void committedPath() {}',
    '}',
    ''
  ].join('\n');

  await fs.writeFile(
    source,
    committedSource,
    'utf8'
  );
  await git(root, ['add', 'src/Versioned.java']);
  await git(root, ['commit', '-m', 'committed fixture']);

  const commit = await git(
    root,
    ['rev-parse', 'HEAD']
  );

  const dirtySource = [
    'package demo;',
    'public class DirtyVersion {',
    '  void dirtyPath() {}',
    '}',
    ''
  ].join('\n');

  await fs.writeFile(
    source,
    dirtySource,
    'utf8'
  );

  return {
    root,
    tempParent,
    source,
    commit,
    committedSource,
    dirtySource
  };
}

function requestMarkdown(
  commit,
  {
    sourceRepository = 'e2e-fixture/mailbox-target',
    id = 'JOB-20260828-e2e'
  } = {}
) {
  return `# KNEEKURA CODE-LAB Job

id: ${id}
status: pending
service: kneekura-code-lab
priority: normal
max_output_tokens: 1200

source_repository: ${sourceRepository}
source_ref: main
source_commit: ${commit}
source_issue:
source_pull_request:
project: mailbox-e2e
requested_by: codex

analysis_mode: architecture

## Question

Explain the committed source boundary.

## Target paths

- \`src/Versioned.java\`

## Known symptoms / observations

- The working tree may contain bytes newer than the requested commit.

## Constraints

- Analyze only the pinned source commit.
- Do not modify the source repository.

## Required output

Use the KNEEKURA service RESULT contract.

## Exclusions

- No external web research.
`;
}

test('REQUEST.md runs through real commit-pinned CORE analysis into service RESULT.md without mutating the target repository', async t => {
  const fixture = await createMailboxRepository(t);
  const core = createCoreEngine();

  const headBefore = await git(
    fixture.root,
    ['rev-parse', 'HEAD']
  );
  const statusBefore = await git(
    fixture.root,
    ['status', '--porcelain=v1']
  );

  const output =
    await runJollyResearchMailboxRequest(
      requestMarkdown(fixture.commit),
      {
        repository: fixture.root,
        core,
        analyzeOptions: {
          commitMaterialization: {
            tempParent: fixture.tempParent
          }
        }
      }
    );

  assert.equal(
    output.job.source_commit,
    fixture.commit
  );
  assert.deepEqual(
    output.execution_plan.core_request.snapshot_selector,
    {
      kind: 'COMMIT',
      commit: fixture.commit
    }
  );
  assert.equal(
    output.execution_plan.output_target.max_output_tokens,
    1200
  );

  assert.equal(
    output.analysis_result.snapshot.kind,
    'COMMIT'
  );
  assert.equal(
    output.analysis_result.snapshot.base_commit,
    fixture.commit
  );
  assert.equal(
    output.service_result.source_commit,
    fixture.commit
  );
  assert.equal(
    output.service_result.source_snapshot_id,
    output.analysis_result.snapshot.snapshot_id
  );
  assert.equal(
    output.service_result.source_repository,
    'e2e-fixture/mailbox-target'
  );

  assert.match(
    output.result_markdown,
    /^# KNEEKURA CODE-LAB Result\n/
  );
  assert.equal(
    output.result_markdown.includes(
      'source_commit: ' + fixture.commit
    ),
    true
  );
  assert.equal(
    output.result_markdown.includes(
      output.analysis_result.snapshot.snapshot_id
    ),
    true
  );

  assert.equal(
    await fs.readFile(fixture.source, 'utf8'),
    fixture.dirtySource
  );
  assert.equal(
    await git(fixture.root, ['rev-parse', 'HEAD']),
    headBefore
  );
  assert.equal(
    await git(fixture.root, ['status', '--porcelain=v1']),
    statusBefore
  );

  const tempEntries =
    await fs.readdir(fixture.tempParent);
  assert.deepEqual(tempEntries, []);
});

test('E2E runner rejects Mailbox source identity that disagrees with the analyzed GitHub repository', async t => {
  const fixture = await createMailboxRepository(t);
  const core = createCoreEngine();

  await assert.rejects(
    () => runJollyResearchMailboxRequest(
      requestMarkdown(
        fixture.commit,
        {
          sourceRepository: 'other-owner/other-repository'
        }
      ),
      {
        repository: fixture.root,
        core,
        analyzeOptions: {
          commitMaterialization: {
            tempParent: fixture.tempParent
          }
        }
      }
    ),
    /sourceRepository does not match AnalysisResult repository identity/
  );

  assert.equal(
    await fs.readFile(fixture.source, 'utf8'),
    fixture.dirtySource
  );
});

test('E2E runner propagates CORE analysis failure after constructing the exact commit-pinned request and does not fabricate a result', async () => {
  const commit = 'a'.repeat(40);
  let capturedRequest = null;
  let capturedOptions = null;

  const core = {
    async analyze(request, options) {
      capturedRequest = structuredClone(request);
      capturedOptions = structuredClone(options);
      const error = new Error(
        'requested commit is unavailable'
      );
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  };

  await assert.rejects(
    () => runJollyResearchMailboxRequest(
      requestMarkdown(commit),
      {
        repository: '/workspace/repository',
        core,
        analyzeOptions: {
          fixture: true
        }
      }
    ),
    error =>
      error?.code === 'INVALID_REQUEST' &&
      /requested commit is unavailable/.test(
        error.message
      )
  );

  assert.deepEqual(
    capturedRequest.snapshot_selector,
    {
      kind: 'COMMIT',
      commit
    }
  );
  assert.equal(
    capturedRequest.repository,
    '/workspace/repository'
  );
  assert.deepEqual(
    capturedOptions,
    {
      fixture: true
    }
  );
});
