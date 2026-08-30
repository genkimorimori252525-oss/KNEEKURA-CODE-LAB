import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExplorerSemanticEdgeDetail,
  createExplorerSemanticModel,
  createExplorerSemanticNodeDetail,
  semanticDomainForEdge,
  semanticDomainForNode,
  semanticStatusTone,
  summarizeExplorerSemanticScope
} from '../src/presentation/explorer/semantic.mjs';

const ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function fixture() {
  const canonicalNodes = [
    node('node:class', 'class'),
    node('node:mixin', 'mixin_target'),
    node('node:packet', 'packet'),
    node(
      'node:runtime',
      'runtime_network_observation',
      { runtimeObservation: true }
    ),
    node('node:molang', 'molang_variable'),
    node('node:animation', 'animation_name'),
    node('node:bone', 'model_bone'),
    node('node:resource', 'ysm_model_resource')
  ];
  const canonicalEdges = [
    edge(
      'edge:send',
      'node:class',
      'node:packet',
      'PACKET_SEND',
      { runtimeObservation: false }
    ),
    edge(
      'edge:receive',
      'node:packet',
      'node:molang',
      'OBSERVED_PACKET_RECEIVE',
      {
        runtimeObservation: true,
        transport_stage: 'M2'
      }
    ),
    edge(
      'edge:m5',
      'node:molang',
      'node:runtime',
      'OBSERVED_YSM_CLIENT_COMMAND_HANDLED',
      {
        runtimeObservation: true,
        transport_stage: 'M5'
      }
    ),
    edge(
      'edge:m6',
      'node:runtime',
      'node:bone',
      'OBSERVED_YSM_MOLANG_STATE_APPLIED',
      {
        runtimeObservation: true,
        transport_stage: 'M6'
      }
    ),
    edge(
      'edge:bone',
      'node:animation',
      'node:bone',
      'ANIMATION_BONE_LINK'
    )
  ];

  const presentationNodes = [
    metaNode('node:class', 0, 'class', 'source', 'Class'),
    metaNode(
      'node:mixin',
      1,
      'mixin_target',
      'forge',
      'Mixin'
    ),
    metaNode(
      'node:packet',
      2,
      'packet',
      'network',
      'Packet'
    ),
    metaNode(
      'node:runtime',
      3,
      'runtime_network_observation',
      'runtime',
      'Runtime'
    ),
    metaNode(
      'node:molang',
      4,
      'molang_variable',
      'semantic',
      '<img src=x onerror=alert(1)>'
    ),
    metaNode(
      'node:animation',
      5,
      'animation_name',
      'semantic',
      'Animation'
    ),
    metaNode(
      'node:bone',
      6,
      'model_bone',
      'semantic',
      'Bone'
    ),
    metaNode(
      'node:resource',
      7,
      'ysm_model_resource',
      'semantic',
      'Resource'
    )
  ];

  const presentationEdges = canonicalEdges.map(
    (item, index) => ({
      edge_id: item.id,
      canonical_index: index,
      from_node_id: item.from,
      to_node_id: item.to,
      canonical_type: item.type
    })
  );

  const projection = {
    schema: 'kneekura.explorer-projection/v1',
    source: {
      analysis_id: 'analysis:p4'
    },
    canonical: {
      graph: {
        schema: 'kneekura.graph/v1',
        nodes: canonicalNodes,
        edges: canonicalEdges
      },
      result: {
        schema: 'core.analysis-result/v1',
        status: 'PARTIAL',
        unknowns: [
          { id: 'unknown:m6', status: 'UNKNOWN' }
        ]
      }
    },
    presentation: {
      nodes: presentationNodes,
      edges: presentationEdges,
      claims: [
        {
          claim_id: 'claim:molang',
          canonical_index: 0,
          subject_node_id: 'node:molang',
          type: 'RUNTIME_REACHABILITY',
          status: 'UNRESOLVED',
          evidence_links: ['evidence:send'],
          counterevidence_links: [
            'evidence:missing-m6'
          ],
          coverage_ref: 'coverage:molang'
        },
        {
          claim_id: 'claim:bone',
          canonical_index: 1,
          subject_node_id: 'node:bone',
          type: 'YSM_BONE',
          status: 'VERIFIED_WITH_LIMITS',
          evidence_links: ['evidence:palette'],
          counterevidence_links: [],
          coverage_ref: 'coverage:bone'
        }
      ],
      coverage: [
        {
          coverage_id: 'coverage:class',
          canonical_index: 0,
          node_id: 'node:class',
          role: 'primary',
          status: 'ANALYZED'
        },
        {
          coverage_id: 'coverage:molang',
          canonical_index: 1,
          node_id: 'node:molang',
          role: 'primary',
          status: 'UNEXPLORED'
        },
        {
          coverage_id: 'coverage:bone',
          canonical_index: 2,
          node_id: 'node:bone',
          role: 'primary',
          status: 'FAILED'
        }
      ]
    }
  };

  const model = {
    schema: 'kneekura.explorer-ui-model/v1',
    projection_schema:
      'kneekura.explorer-projection/v1',
    source: structuredClone(projection.source),
    nodes: presentationNodes.map(item => ({
      id: item.node_id,
      canonical_index: item.canonical_index,
      position: { x: 0, y: 0 },
      width: 240,
      height: 72,
      data: {
        label: item.label,
        canonical_kind: item.canonical_kind,
        display_family: item.display_family,
        canonical_node_id: item.node_id
      }
    })),
    edges: presentationEdges.map(item => ({
      id: item.edge_id,
      canonical_index: item.canonical_index,
      source: item.from_node_id,
      target: item.to_node_id,
      data: {
        canonical_edge_id: item.edge_id,
        canonical_type: item.canonical_type
      }
    }))
  };

  return { projection, model };
}

function node(id, kind, extra = {}) {
  return { id, kind, ...extra };
}

function edge(
  id,
  from,
  to,
  type,
  extra = {}
) {
  return { id, from, to, type, ...extra };
}

function metaNode(
  nodeId,
  canonicalIndex,
  canonicalKind,
  displayFamily,
  label
) {
  return {
    node_id: nodeId,
    canonical_index: canonicalIndex,
    canonical_kind: canonicalKind,
    display_family: displayFamily,
    label
  };
}

test('P4 maps existing KNEEKURA kinds to fixed Presentation domains only', () => {
  assert.equal(
    semanticDomainForNode(
      'molang_variable',
      'semantic'
    ),
    'molang'
  );
  assert.equal(
    semanticDomainForNode(
      'animation_name',
      'semantic'
    ),
    'animation'
  );
  assert.equal(
    semanticDomainForNode(
      'model_bone',
      'semantic'
    ),
    'bone'
  );
  assert.equal(
    semanticDomainForNode(
      'ysm_model_resource',
      'semantic'
    ),
    'resource'
  );
  assert.equal(
    semanticDomainForNode(
      'packet',
      'network'
    ),
    'network'
  );
  assert.equal(
    semanticDomainForNode(
      'mixin_target',
      'forge'
    ),
    'forge'
  );
  assert.equal(
    semanticDomainForNode(
      '<script>alert(1)</script>',
      '<img onerror=alert(1)>'
    ),
    'canonical'
  );
});

test('P4 preserves canonical edge type, endpoints, runtime observation and exact M-stage', () => {
  const { projection, model } = fixture();
  const semantic =
    createExplorerSemanticModel(
      projection,
      model
    );
  const receive = semantic.edges.find(
    item => item.edge_id === 'edge:receive'
  );
  const m5 = semantic.edges.find(
    item => item.edge_id === 'edge:m5'
  );
  const m6 = semantic.edges.find(
    item => item.edge_id === 'edge:m6'
  );

  assert.deepEqual(
    {
      type: receive.canonical_type,
      source: receive.source,
      target: receive.target,
      runtime: receive.runtime_observation,
      stage: receive.transport_stage,
      domain: receive.domain
    },
    {
      type: 'OBSERVED_PACKET_RECEIVE',
      source: 'node:packet',
      target: 'node:molang',
      runtime: 'observed',
      stage: 'M2',
      domain: 'network'
    }
  );
  assert.equal(m5.transport_stage, 'M5');
  assert.equal(m6.transport_stage, 'M6');
  assert.notEqual(m5.transport_stage, m6.transport_stage);
  assert.equal(
    semanticDomainForEdge(
      m6.canonical_type,
      projection.canonical.graph.edges[3]
    ),
    'molang'
  );
});

test('P4 unobserved remains distinct from failed and later stages do not fill gaps', () => {
  const { projection, model } = fixture();
  const semantic =
    createExplorerSemanticModel(
      projection,
      model
    );
  const send = semantic.edges.find(
    item => item.edge_id === 'edge:send'
  );
  const molang = semantic.nodes.find(
    item => item.node_id === 'node:molang'
  );

  assert.equal(
    send.runtime_observation,
    'unobserved'
  );
  assert.equal(send.transport_stage, null);
  assert.equal(
    semanticStatusTone('UNEXPLORED'),
    'unknown'
  );
  assert.equal(
    semanticStatusTone('FAILED'),
    'failed'
  );
  assert.deepEqual(
    molang.claim_statuses,
    ['UNRESOLVED']
  );
  assert.deepEqual(
    molang.coverage_statuses,
    ['UNEXPLORED']
  );
});

test('P4 node detail preserves Claim Evidence Counterevidence and Coverage trace verbatim', () => {
  const { projection, model } = fixture();
  const semantic =
    createExplorerSemanticModel(
      projection,
      model
    );
  const detail =
    createExplorerSemanticNodeDetail(
      projection,
      semantic,
      'node:molang'
    );

  assert.equal(detail.decoration.domain, 'molang');
  assert.deepEqual(
    detail.claims[0].evidence_links,
    ['evidence:send']
  );
  assert.deepEqual(
    detail.claims[0].counterevidence_links,
    ['evidence:missing-m6']
  );
  assert.equal(
    detail.claims[0].status,
    'UNRESOLVED'
  );
  assert.equal(
    detail.coverage[0].status,
    'UNEXPLORED'
  );
  assert.equal(
    semantic.analysis.status,
    'PARTIAL'
  );
  assert.equal(
    semantic.analysis.unknown_count,
    1
  );
});

test('P4 edge detail is source-traceable and does not synthesize edge identity', () => {
  const { projection, model } = fixture();
  const semantic =
    createExplorerSemanticModel(
      projection,
      model
    );
  const detail =
    createExplorerSemanticEdgeDetail(
      projection,
      semantic,
      'edge:m6'
    );

  assert.equal(detail.edge_id, 'edge:m6');
  assert.equal(
    detail.canonical_edge.id,
    detail.edge_id
  );
  assert.equal(
    detail.decoration.canonical_type,
    detail.canonical_edge.type
  );
  assert.equal(
    detail.decoration.source,
    detail.canonical_edge.from
  );
  assert.equal(
    detail.decoration.target,
    detail.canonical_edge.to
  );
});

test('P4 semantic derivation is deterministic, non-mutating, and fails closed on identity mismatch', () => {
  const { projection, model } = fixture();
  const projectionBefore =
    structuredClone(projection);
  const modelBefore = structuredClone(model);

  const first =
    createExplorerSemanticModel(
      projection,
      model
    );
  const second =
    createExplorerSemanticModel(
      projection,
      model
    );

  assert.deepEqual(first, second);
  assert.deepEqual(projection, projectionBefore);
  assert.deepEqual(model, modelBefore);

  const badModel = structuredClone(model);
  badModel.edges[0].data.canonical_type =
    'PRESENTATION_INVENTED_TYPE';
  assert.throws(
    () => createExplorerSemanticModel(
      projection,
      badModel
    ),
    /edge trace mismatch/
  );
});

test('P4 scope summary counts only visible canonical identities', () => {
  const { projection, model } = fixture();
  const semantic =
    createExplorerSemanticModel(
      projection,
      model
    );
  const summary =
    summarizeExplorerSemanticScope(
      semantic,
      {
        visible_node_ids: [
          'node:packet',
          'node:molang',
          'node:bone'
        ],
        visible_edge_ids: [
          'edge:receive',
          'edge:m6'
        ]
      }
    );

  assert.deepEqual(
    summary.node_domains,
    [
      { domain: 'network', count: 1 },
      { domain: 'molang', count: 1 },
      { domain: 'bone', count: 1 }
    ]
  );
  assert.deepEqual(
    summary.edge_domains,
    [
      { domain: 'network', count: 1 },
      { domain: 'molang', count: 1 }
    ]
  );
});

test('P4 React shell keeps repository text inert and uses fixed semantic tokens', async () => {
  const [app, css] = await Promise.all([
    fs.readFile(
      path.join(
        ROOT,
        'packages/human-explorer/src/App.jsx'
      ),
      'utf8'
    ),
    fs.readFile(
      path.join(
        ROOT,
        'packages/human-explorer/src/styles.css'
      ),
      'utf8'
    )
  ]);
  const source = app + '\n' + css;

  for (const required of [
    'createExplorerSemanticModel',
    'createExplorerSemanticEdgeDetail',
    'SemanticLegend',
    'SemanticBadge',
    'onEdgeClick',
    'explorer-node-domain-molang',
    'explorer-edge-domain-network'
  ]) {
    assert.equal(
      source.includes(required),
      true,
      'missing P4 semantic UI capability: ' +
      required
    );
  }

  for (const forbidden of [
    'dangerouslySetInnerHTML',
    '.innerHTML',
    'eval(',
    'new Function',
    'javascript:'
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      'forbidden P4 rendering path: ' + forbidden
    );
  }
});

test('P4 remains Presentation-only, CI-covered, Classic-default, and excludes Render Pack parity work', async () => {
  const [pkgText, ci, cli, doc] = await Promise.all([
    fs.readFile(
      path.join(ROOT, 'package.json'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, 'src/cli.mjs'),
      'utf8'
    ),
    fs.readFile(
      path.join(ROOT, 'docs/HUMAN_PRESENTATION_V2.md'),
      'utf8'
    )
  ]);
  const pkg = JSON.parse(pkgText);

  assert.equal(
    pkg.scripts['test:presentation-p4'],
    'node --test test/human-presentation-v2-p4.test.mjs'
  );
  assert.match(ci, /npm run test:presentation-p4/);
  assert.equal(
    pkg.scripts.serve,
    'node src/cli.mjs serve'
  );
  assert.match(cli, /cmd === 'serve'/);
  assert.match(
    doc,
    /P4 — KNEEKURA Semantic Visualization contract/
  );
  assert.match(
    doc,
    /Render Pack and pixel-parity work are explicitly outside P4/
  );
});
