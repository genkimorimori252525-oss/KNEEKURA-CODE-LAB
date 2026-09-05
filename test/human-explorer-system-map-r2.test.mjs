import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHumanExplorerSystemMap,
  resolveHumanExplorerSelection,
  searchHumanExplorerSystemMap,
  SYSTEM_MAP_AUTHORITY
} from '../packages/human-explorer/src/system-map.mjs';

function fileRef(path, start, end, digestChar) {
  return {
    kind: 'FILE_RANGE',
    path,
    start_line: start,
    end_line: end,
    content_digest: 'sha256:' + digestChar.repeat(64)
  };
}

function canonicalPoorFixture() {
  const agentRef = fileRef(
    'packages/orchestration/src/agent-service.ts',
    10,
    12,
    'a'
  );
  const gitRef = fileRef(
    'packages/git/src/publish.ts',
    20,
    22,
    'b'
  );
  const items = [
    {
      id: 'item:component',
      stage: 'ARCHITECTURE',
      kind: 'ARCHITECTURE_COMPONENT',
      semantic_class: 'AI_INTERPRETATION',
      title: 'Agent Service',
      body: 'workspaceの公開要求を調停します。',
      source_refs: [agentRef],
      review_status: 'ACCEPT'
    },
    {
      id: 'item:git',
      stage: 'ARCHITECTURE',
      kind: 'ARCHITECTURE_COMPONENT',
      semantic_class: 'AI_INTERPRETATION',
      title: 'Git Publish',
      body: 'publish処理です。',
      source_refs: [gitRef],
      review_status: 'ACCEPT'
    },
    {
      id: 'item:tour',
      stage: 'TOUR',
      kind: 'TOUR_STEP',
      semantic_class: 'AI_INTERPRETATION',
      title: '公開経路を見る',
      body: 'Agent Serviceから確認します。',
      source_refs: [agentRef],
      review_status: 'ACCEPT'
    }
  ];
  const repository = {
    repository_id: 'repo:test',
    snapshot_id: 'snapshot:test'
  };
  return {
    projection: {
      schema: 'kneekura.explorer-projection/v1',
      source: repository,
      canonical: {
        graph: { nodes: [], edges: [] },
        result: { claims: [], coverage: { entries: [] } }
      },
      presentation: {
        nodes: [], edges: [], claims: [], coverage: []
      }
    },
    offlinePayload: {
      schema: 'kneekura.human-experience-offline-payload/v1',
      experience: {
        schema: 'kneekura.human-experience-projection/v1',
        repository,
        derived: {
          human_analysis_ir: {
            schema: 'kneekura.human-analysis-ir/v1',
            items
          }
        }
      },
      sources: {
        schema: 'kneekura.human-analysis-source-bundle/v1',
        records: [
          {
            ref: agentRef,
            text: 'export class AgentService {\n  publish() {}\n}'
          },
          {
            ref: gitRef,
            text: 'export function publish() {\n  return true;\n}'
          }
        ]
      },
      presentation: {
        schema: 'kneekura.human-analysis-presentation/v1',
        components: [
          {
            component_id: 'component:agent',
            item_id: 'item:component',
            name: 'Agent Service',
            responsibility: 'workspace公開要求の調停',
            member_refs: [agentRef]
          }
        ],
        tour: [
          {
            item_id: 'item:tour',
            order: 0,
            target_refs: [agentRef]
          }
        ]
      }
    }
  };
}

function canonicalFixture() {
  const node = {
    id: 'node:boot',
    kind: 'function',
    path: 'src/boot.ts',
    label: 'boot'
  };
  const tour = {
    id: 'node:tour',
    kind: 'ua:tour_step',
    label: '起動を見る',
    description: 'bootを確認します。',
    order: 1
  };
  return {
    projection: {
      schema: 'kneekura.explorer-projection/v1',
      source: {
        repository_id: 'repo:canonical',
        snapshot_id: 'snapshot:canonical'
      },
      canonical: {
        graph: {
          nodes: [node, tour],
          edges: [
            {
              id: 'edge:tour-boot',
              type: 'UA_TOUR_HIGHLIGHTS',
              from: tour.id,
              to: node.id
            }
          ]
        },
        result: { claims: [], coverage: { entries: [] } }
      },
      presentation: {
        nodes: [
          {
            canonical_index: 0,
            node_id: node.id,
            canonical_kind: node.kind,
            display_family: 'source',
            label: 'boot'
          },
          {
            canonical_index: 1,
            node_id: tour.id,
            canonical_kind: tour.kind,
            display_family: 'guide',
            label: '起動を見る'
          }
        ],
        edges: [
          {
            canonical_index: 0,
            edge_id: 'edge:tour-boot',
            from_node_id: tour.id,
            to_node_id: node.id,
            canonical_type: 'UA_TOUR_HIGHLIGHTS'
          }
        ],
        claims: [],
        coverage: []
      }
    },
    offlinePayload: null
  };
}

test('R2 creates useful bounded L0-L3 exploration for a canonical-poor repository', () => {
  const fixture = canonicalPoorFixture();
  const model = createHumanExplorerSystemMap(fixture);
  assert.deepEqual(model.levels.map(item => item.level), [0, 1, 2, 3]);
  assert(model.entities.some(entity => entity.kind === 'COMPONENT' && entity.level === 1));
  assert(model.entities.some(entity => entity.kind === 'DOMAIN' && entity.level === 1));
  assert(model.entities.some(entity => entity.kind === 'PACKAGE' && entity.level === 2));
  assert(model.entities.some(entity => entity.kind === 'FILE' && entity.level === 2));
  assert(model.entities.some(entity => entity.kind === 'SOURCE' && entity.level === 3));
  assert.equal(model.stats.canonical_entities, 0);
  for (const entity of model.entities) {
    if (entity.authority !== SYSTEM_MAP_AUTHORITY.CANONICAL) {
      assert.equal(entity.canonical_node_id, null);
    }
  }
});

test('R2 repository-wide search is independent from canonical visible scope', () => {
  const model = createHumanExplorerSystemMap(canonicalPoorFixture());
  const results = searchHumanExplorerSystemMap(model, 'packages/git/src/publish.ts');
  assert(results.some(result => result.path === 'packages/git/src/publish.ts'));
  assert(results.some(result => result.kind === 'SOURCE' || result.kind === 'FILE'));
});

test('R2 shared resolver exposes source text without inventing canonical Change Impact eligibility', () => {
  const model = createHumanExplorerSystemMap(canonicalPoorFixture());
  const result = searchHumanExplorerSystemMap(model, 'agent-service.ts')
    .find(entry => entry.kind === 'SOURCE');
  assert(result);
  const resolved = resolveHumanExplorerSelection(model, result.selection_id);
  assert.equal(resolved.authority, SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY);
  assert.equal(resolved.canonical_node_id, null);
  assert.equal(resolved.can_change_impact, false);
  assert.equal(resolved.sources.length, 1);
  assert.equal(resolved.sources[0].rows[0].line, 10);
  assert.match(resolved.sources[0].rows[0].text, /AgentService/);
});

test('R2 AI-authored tour targets use the same shared source selection resolver', () => {
  const model = createHumanExplorerSystemMap(canonicalPoorFixture());
  const tour = model.tours.find(item => item.kind === 'AI_AUTHORED');
  assert(tour);
  assert.equal(tour.steps.length, 1);
  const selectionId = tour.steps[0].target_selection_ids[0];
  const resolved = resolveHumanExplorerSelection(model, selectionId);
  assert(resolved);
  assert.equal(resolved.entity.kind, 'SOURCE');
  assert.equal(resolved.can_change_impact, false);
  assert.match(resolved.sources[0].path, /agent-service\.ts$/);
});

test('R2 canonical selections and canonical tour retain real canonical IDs for Change Impact', () => {
  const model = createHumanExplorerSystemMap(canonicalFixture());
  const boot = searchHumanExplorerSystemMap(model, 'boot')
    .find(entry => entry.authority === SYSTEM_MAP_AUTHORITY.CANONICAL);
  assert(boot);
  const resolved = resolveHumanExplorerSelection(model, boot.selection_id);
  assert.equal(resolved.canonical_node_id, 'node:boot');
  assert.equal(resolved.can_change_impact, true);

  const tour = model.tours.find(item => item.kind === 'CANONICAL');
  assert(tour);
  assert.equal(tour.steps.length, 1);
  const target = resolveHumanExplorerSelection(
    model,
    tour.steps[0].target_selection_ids[0]
  );
  assert.equal(target.canonical_node_id, 'node:boot');
  assert.equal(target.can_change_impact, true);
});