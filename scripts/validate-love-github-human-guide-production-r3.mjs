import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildStandaloneHumanExplorerShell
} from '../src/human-experience/index.mjs';
import {
  compileProductionHumanExperienceArtifactWithTechnicalViews,
  createHumanAnalysisTechnicalViews,
  validateHumanAnalysisTechnicalViews,
  writeHumanAnalysisArtifact
} from '../src/human-analysis/index.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R1_ROOT = path.join(ROOT, 'dist', 'r1-love-github-production');
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'r3-love-github-production');

await import('./validate-love-github-human-guide-production-r1.mjs');

const [ir, presentation, experience, sourceBundle] = await Promise.all([
  readJson(path.join(R1_ROOT, 'analysis.json')),
  readJson(path.join(R1_ROOT, 'presentation.json')),
  readJson(path.join(R1_ROOT, 'experience.json')),
  readJson(path.join(R1_ROOT, 'sources.json'))
]);

const technicalViews = createHumanAnalysisTechnicalViews({
  ir,
  presentation,
  spec: buildLoveGithubSpec(presentation)
});
assert.equal(
  validateHumanAnalysisTechnicalViews(technicalViews, { ir, presentation }),
  true
);

assert.equal(technicalViews.architecture.relations.length, 2);
assert.equal(technicalViews.architecture.relations[0].confirmation, 'CONFIRMED');
assert.equal(technicalViews.architecture.relations[1].confirmation, 'UNCONFIRMED');
assert(technicalViews.workflow.transitions.length >= 5);
assert.equal(technicalViews.sequence.messages.filter(row => row.confirmation === 'CONFIRMED').length, 4);
assert.equal(technicalViews.sequence.messages.filter(row => row.confirmation === 'UNCONFIRMED').length, 1);
assert.equal(technicalViews.sequence.messages.find(row => row.confirmation === 'UNCONFIRMED').order, null);
assert.equal(technicalViews.data_flow.transfers.length, 4);
assert.equal(technicalViews.lifecycle.transitions.filter(row => row.confirmation === 'UNCONFIRMED').length, 1);

const shell = await buildStandaloneHumanExplorerShell();
const compile = () => compileProductionHumanExperienceArtifactWithTechnicalViews({
  experience,
  sources: sourceBundle.records,
  presentation,
  technicalViews,
  title: 'Love-Github Human Explorer — R3 evidence-backed technical views',
  explorerShell: shell
});
const one = await compile();
const two = await compile();
assert.equal(one.artifact_id, two.artifact_id);
assert.equal(one.index_html, two.index_html);
assert(one.zip_bytes.equals(two.zip_bytes));
assert.equal(one.zip_digest, two.zip_digest);
assert.equal(one.manifest.technical_views.view_set_id, technicalViews.view_set_id);
assert(one.files.some(file => file.path === 'technical-views.json'));

await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
const written = await writeHumanAnalysisArtifact({
  artifact: one,
  outDir: OUTPUT_ROOT,
  zipFile: 'love-github-r3-human-explorer.zip'
});
validateFileBrowser(written.index_path);

const report = {
  schema: 'kneekura.live-love-github-production-r3/v1',
  analyzed_repository: 'genkimorimori252525-oss/Love-Github',
  analyzed_commit: '5d647785bfeee1b8892e9ba782b04a76f1b63fff',
  technical_view_set_id: technicalViews.view_set_id,
  architecture_relations: technicalViews.architecture.relations.length,
  workflow_steps: technicalViews.workflow.steps.length,
  workflow_transitions: technicalViews.workflow.transitions.length,
  sequence_confirmed_messages: technicalViews.sequence.messages.filter(row => row.confirmation === 'CONFIRMED').length,
  sequence_unconfirmed_messages: technicalViews.sequence.messages.filter(row => row.confirmation === 'UNCONFIRMED').length,
  data_transfers: technicalViews.data_flow.transfers.length,
  lifecycle_states: technicalViews.lifecycle.states.length,
  lifecycle_confirmed_transitions: technicalViews.lifecycle.transitions.filter(row => row.confirmation === 'CONFIRMED').length,
  lifecycle_unconfirmed_transitions: technicalViews.lifecycle.transitions.filter(row => row.confirmation === 'UNCONFIRMED').length,
  technical_views_file_present: true,
  deterministic_replay: true,
  file_browser_verified: true,
  artifact_id: one.artifact_id,
  zip_digest: one.zip_digest,
  zip_bytes: one.zip_bytes.length
};
await fs.writeFile(
  path.join(OUTPUT_ROOT, 'r3-production-report.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf8'
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

function buildLoveGithubSpec(presentation) {
  const component = name => {
    const found = presentation.components.find(item => item.name === name);
    if (!found) throw new Error(`R3_COMPONENT_MISSING:${name}`);
    return found;
  };
  const agent = component('Agent操作境界');
  const publisher = component('Workspace公開エンジン');
  const githubRequester = component('GitHub認証付きrequester');
  const flow = presentation.flows.find(item => item.name === 'workspace publish');
  if (!flow) throw new Error('R3_FLOW_MISSING:workspace publish');
  const step = id => {
    const found = flow.steps.find(item => item.step_id === id);
    if (!found) throw new Error(`R3_STEP_MISSING:${id}`);
    return found;
  };
  const transition = (from, to) => {
    const found = flow.transitions.find(item =>
      item.from_step_id === from && item.to_step_id === to
    );
    if (!found) throw new Error(`R3_TRANSITION_MISSING:${from}->${to}`);
    return found;
  };
  const refs = (...values) => {
    const map = new Map();
    for (const value of values.flat()) {
      const key = JSON.stringify(value);
      map.set(key, value);
    }
    return [...map.values()];
  };

  const aToP = refs(agent.member_refs, publisher.member_refs);
  const agentUpstream = transition('agent-publish', 'trusted-upstream');
  const upstreamFreshness = transition('trusted-upstream', 'branch-freshness');
  const freshnessChanges = transition('branch-freshness', 'collect-changes');
  const freshnessStale = transition('branch-freshness', 'stale-state');
  const changesCommit = transition('collect-changes', 'atomic-commit');

  return {
    architecture: {
      title: 'Love-Github 公開経路の責務境界',
      component_ids: [agent.component_id, publisher.component_id, githubRequester.component_id],
      relations: [
        {
          from_component_id: agent.component_id,
          to_component_id: publisher.component_id,
          type: 'DELEGATES_PUBLISH',
          direction: 'FORWARD',
          confirmation: 'CONFIRMED',
          source_refs: aToP
        },
        {
          from_component_id: publisher.component_id,
          to_component_id: githubRequester.component_id,
          type: 'REACHES_AUTHENTICATED_GITHUB_REQUESTER',
          direction: 'FORWARD',
          confirmation: 'UNCONFIRMED',
          unconfirmed_reason: 'このbounded scopeではWorkspacePublisherからRefreshingInstallationRequesterまでの直接call chainを確認していないため、接続を確定矢印にしません。',
          source_refs: []
        }
      ]
    },
    workflow: {
      flow_id: flow.flow_id,
      title: 'workspace publish workflow'
    },
    sequence: {
      flow_id: flow.flow_id,
      title: '公開要求からatomic commitまでの確認済み順序',
      messages: [
        confirmedSequence(agentUpstream, 1, 'AgentServiceからWorkspacePublisherへ公開要求を渡す'),
        confirmedSequence(upstreamFreshness, 2, 'trusted upstreamを得てtask branchを確認する'),
        confirmedSequence(freshnessChanges, 3, 'freshness確認後にworkspace変更を収集する'),
        confirmedSequence(changesCommit, 4, '変更集合とexpected headをatomic commitへ渡す'),
        {
          from_step_id: 'stale-state',
          to_step_id: 'atomic-commit',
          label: 'STALE_STATE後にatomic commitへ進む',
          confirmation: 'UNCONFIRMED',
          unconfirmed_reason: 'STALE_STATEはresolveBranchからエラーとして返り、確認範囲ではatomicCommitへ進む経路を示していません。',
          source_refs: []
        }
      ]
    },
    data_flow: {
      flow_id: flow.flow_id,
      title: '公開処理で渡されるデータ',
      transfers: [
        confirmedTransfer(agentUpstream, 'PublishWorkspaceInputとworkspace identity'),
        confirmedTransfer(upstreamFreshness, 'trusted upstreamとtask branch SHA'),
        confirmedTransfer(freshnessChanges, 'freshness確認済みbranch context'),
        confirmedTransfer(changesCommit, 'WorkspaceChangeSetとexpectedHeadSha'),
        {
          from_step_id: freshnessStale.from_step_id,
          to_step_id: freshnessStale.to_step_id,
          label: 'expected/actual SHA mismatch',
          direction: 'FORWARD',
          confirmation: 'CONFIRMED',
          source_refs: freshnessStale.source_refs
        }
      ]
    },
    lifecycle: {
      flow_id: flow.flow_id,
      title: '1回のpublish試行の状態遷移',
      states: [
        { state_id: 'guarded', label: '公開要求guard済み', source_refs: step('agent-publish').source_refs },
        { state_id: 'branch-check', label: 'task branch確認中', source_refs: step('branch-freshness').source_refs },
        { state_id: 'changes-collected', label: '変更集合収集済み', source_refs: step('collect-changes').source_refs },
        { state_id: 'committed', label: 'atomic commit実行', source_refs: step('atomic-commit').source_refs },
        { state_id: 'stale-stopped', label: 'STALE_STATEで停止', source_refs: step('stale-state').source_refs }
      ],
      transitions: [
        confirmedLifecycle('guarded', 'branch-check', 'trusted upstreamとbranchを確認する', refs(agentUpstream.source_refs, upstreamFreshness.source_refs)),
        confirmedLifecycle('branch-check', 'changes-collected', 'remote SHAが期待値と一致', freshnessChanges.source_refs),
        confirmedLifecycle('changes-collected', 'committed', '変更集合をatomic commitへ渡す', changesCommit.source_refs),
        confirmedLifecycle('branch-check', 'stale-stopped', 'remote driftを検出', freshnessStale.source_refs),
        {
          from_state_id: 'stale-stopped',
          to_state_id: 'committed',
          label: 'STALE_STATE後に同じ試行でcommitする',
          confirmation: 'UNCONFIRMED',
          unconfirmed_reason: '確認した実装ではSTALE_STATEを返してpublishを停止するため、この遷移は確認できません。',
          source_refs: []
        }
      ]
    }
  };
}

function confirmedSequence(transition, order, label) {
  return {
    from_step_id: transition.from_step_id,
    to_step_id: transition.to_step_id,
    label,
    order,
    confirmation: 'CONFIRMED',
    source_refs: transition.source_refs
  };
}

function confirmedTransfer(transition, label) {
  return {
    from_step_id: transition.from_step_id,
    to_step_id: transition.to_step_id,
    label,
    direction: 'FORWARD',
    confirmation: 'CONFIRMED',
    source_refs: transition.source_refs
  };
}

function confirmedLifecycle(from, to, label, sourceRefs) {
  return {
    from_state_id: from,
    to_state_id: to,
    label,
    confirmation: 'CONFIRMED',
    source_refs: sourceRefs
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  const found = candidates.find(candidate => fsSync.existsSync(candidate));
  if (!found) throw new Error('R3_CHROME_NOT_FOUND');
  return found;
}

function validateFileBrowser(indexPath) {
  const profile = path.join(os.tmpdir(), `kneekura-r3-chrome-${process.pid}`);
  const launched = spawnSync(
    findChrome(),
    [
      '--headless=new', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--no-first-run',
      '--no-default-browser-check', '--virtual-time-budget=8000',
      `--user-data-dir=${profile}`, '--dump-dom', pathToFileURL(indexPath).href
    ],
    { encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  );
  try {
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(`R3_CHROME_FAILED:${launched.status}:${String(launched.stderr ?? '').slice(-3000)}`);
    }
    const dom = String(launched.stdout ?? '');
    for (const expected of [
      '技術ビュー', 'Architecture', 'Workflow', 'Sequence', 'Data Flow', 'Lifecycle',
      '順序未確認', 'STALE_STATE後にatomic commitへ進む',
      'packages/orchestration/src/agent-service.ts'
    ]) {
      assert(dom.includes(expected), `R3 rendered DOM missing: ${expected}`);
    }
    assert(!dom.includes('Explorer presentation failed.'));
  } finally {
    fsSync.rmSync(profile, { recursive: true, force: true });
  }
}