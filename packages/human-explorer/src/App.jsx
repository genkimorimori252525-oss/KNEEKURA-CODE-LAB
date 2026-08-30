import React, {
  useEffect,
  useMemo,
  useState
} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';

import {
  createExplorerNodeDetail,
  createExplorerUiModel
} from '../../../src/presentation/explorer/ui-model.mjs';
import {
  createExplorerHierarchy,
  createExplorerScope,
  EXPLORER_ROOT_CONTAINER_ID,
  searchExplorerScopeNodes
} from '../../../src/presentation/explorer/hierarchy.mjs';
import {
  createExplorerSemanticEdgeDetail,
  createExplorerSemanticModel,
  createExplorerSemanticNodeDetail,
  summarizeExplorerSemanticScope
} from '../../../src/presentation/explorer/semantic.mjs';
import {
  layoutExplorerUiModel
} from '../../../src/presentation/explorer/layout.mjs';

const elk = new ELK();

export function ExplorerApp({ projection }) {
  return (
    <ReactFlowProvider>
      <ExplorerCanvas projection={projection} />
    </ReactFlowProvider>
  );
}

function ExplorerCanvas({ projection }) {
  const model = useMemo(
    () => createExplorerUiModel(projection),
    [projection]
  );
  const hierarchy = useMemo(
    () => createExplorerHierarchy(model),
    [model]
  );
  const semanticModel = useMemo(
    () => createExplorerSemanticModel(
      projection,
      model
    ),
    [projection, model]
  );
  const semanticNodeById = useMemo(
    () => new Map(
      semanticModel.nodes.map(item => [
        item.node_id,
        item
      ])
    ),
    [semanticModel]
  );
  const semanticEdgeById = useMemo(
    () => new Map(
      semanticModel.edges.map(item => [
        item.edge_id,
        item
      ])
    ),
    [semanticModel]
  );
  const [containerId, setContainerId] = useState(
    EXPLORER_ROOT_CONTAINER_ID
  );
  const [enabledLayerIds, setEnabledLayerIds] =
    useState(() =>
      hierarchy.layers.map(layer => layer.id)
    );
  const [layout, setLayout] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] =
    useState(null);
  const [selectedEdgeId, setSelectedEdgeId] =
    useState(null);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(
      hierarchy.layers.map(layer => layer.id)
    );
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [hierarchy]);

  const scope = useMemo(
    () => createExplorerScope(model, hierarchy, {
      container_id: containerId,
      enabled_layer_ids: enabledLayerIds
    }),
    [
      model,
      hierarchy,
      containerId,
      enabledLayerIds
    ]
  );

  const scopedModel = useMemo(
    () => ({
      ...model,
      nodes: scope.nodes,
      edges: scope.edges
    }),
    [model, scope]
  );
  const semanticScopeSummary = useMemo(
    () => summarizeExplorerSemanticScope(
      semanticModel,
      scope
    ),
    [semanticModel, scope]
  );

  useEffect(() => {
    let active = true;
    setLayout(null);
    setLayoutError(null);

    if (scopedModel.nodes.length === 0) {
      setLayout({
        ...scopedModel,
        nodes: [],
        edges: []
      });
      return () => {
        active = false;
      };
    }

    layoutExplorerUiModel(scopedModel, elk)
      .then(value => {
        if (active) setLayout(value);
      })
      .catch(error => {
        if (active) {
          setLayoutError(
            String(error?.message ?? error)
          );
        }
      });

    return () => {
      active = false;
    };
  }, [scopedModel]);

  const matches = useMemo(
    () => searchExplorerScopeNodes(scope, query),
    [scope, query]
  );
  const matchSet = useMemo(
    () => new Set(matches),
    [matches]
  );
  const visibleNodeSet = useMemo(
    () => new Set(scope.visible_node_ids),
    [scope.visible_node_ids]
  );

  useEffect(() => {
    if (
      selectedNodeId &&
      !visibleNodeSet.has(selectedNodeId)
    ) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, visibleNodeSet]);

  useEffect(() => {
    if (
      selectedEdgeId &&
      !scope.visible_edge_ids.includes(
        selectedEdgeId
      )
    ) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId, scope.visible_edge_ids]);

  const visibleNodes = useMemo(() => {
    const source = layout?.nodes ?? scope.nodes;
    return source.map(node => {
      const semantic =
        semanticNodeById.get(node.id);
      const classes = [
        'explorer-node',
        semantic
          ? 'explorer-node-domain-' +
            semantic.domain
          : null,
        node.id === selectedNodeId
          ? 'explorer-node-selected'
          : null,
        matchSet.has(node.id)
          ? 'explorer-node-match'
          : null
      ].filter(Boolean);

      return {
        ...node,
        draggable: false,
        className: classes.join(' ')
      };
    });
  }, [
    layout,
    scope.nodes,
    matchSet,
    selectedNodeId,
    semanticNodeById
  ]);

  const visibleEdges = useMemo(() => {
    const source = layout?.edges ?? scope.edges;
    return source.map(edge => {
      const semantic =
        semanticEdgeById.get(edge.id);
      return {
        ...edge,
        className: semantic
          ? 'explorer-edge explorer-edge-domain-' +
            semantic.domain
          : 'explorer-edge',
        data: {
          ...edge.data,
          semantic_domain:
            semantic?.domain ?? 'canonical'
        }
      };
    });
  }, [
    layout,
    scope.edges,
    semanticEdgeById
  ]);

  const detail = useMemo(
    () => selectedNodeId
      ? createExplorerNodeDetail(
          projection,
          selectedNodeId
        )
      : null,
    [projection, selectedNodeId]
  );
  const semanticNodeDetail = useMemo(
    () => selectedNodeId
      ? createExplorerSemanticNodeDetail(
          projection,
          semanticModel,
          selectedNodeId
        )
      : null,
    [
      projection,
      semanticModel,
      selectedNodeId
    ]
  );
  const edgeDetail = useMemo(
    () => selectedEdgeId
      ? createExplorerSemanticEdgeDetail(
          projection,
          semanticModel,
          selectedEdgeId
        )
      : null,
    [
      projection,
      semanticModel,
      selectedEdgeId
    ]
  );

  function focusNode(nodeId) {
    if (!nodeId || !visibleNodeSet.has(nodeId)) return;
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    queueMicrotask(() => {
      fitView({
        nodes: [{ id: nodeId }],
        padding: 0.8,
        duration: 240,
        maxZoom: 1.5
      });
    });
  }

  function submitSearch(event) {
    event.preventDefault();
    focusNode(matches[0] ?? null);
  }

  function navigateContainer(nextId) {
    setContainerId(nextId);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }

  function toggleLayer(layerId) {
    setEnabledLayerIds(current => {
      const next = current.includes(layerId)
        ? current.filter(id => id !== layerId)
        : [...current, layerId];
      return next.sort();
    });
  }

  return (
    <div className="explorer-shell">
      <header className="explorer-toolbar">
        <div>
          <strong>KNEEKURA Human Explorer</strong>
          <span className="explorer-subtitle">
            P3 hierarchy · canonical projection consumer
          </span>
        </div>

        <form
          className="explorer-search"
          onSubmit={submitSearch}
        >
          <input
            value={query}
            onChange={event =>
              setQuery(event.target.value)
            }
            placeholder="visible node / kind / id を検索"
            aria-label="Explorer node search"
          />
          <button type="submit">
            Focus
          </button>
          <span aria-live="polite">
            {query ? matches.length + ' matches' : ''}
          </span>
        </form>

        <button
          type="button"
          onClick={() =>
            fitView({
              padding: 0.18,
              duration: 240
            })
          }
        >
          Fit scope
        </button>
      </header>

      <main className="explorer-main">
        <HierarchyPanel
          hierarchy={hierarchy}
          scope={scope}
          semanticModel={semanticModel}
          semanticScopeSummary={semanticScopeSummary}
          containerId={containerId}
          enabledLayerIds={enabledLayerIds}
          onNavigate={navigateContainer}
          onToggleLayer={toggleLayer}
        />

        <section className="explorer-canvas">
          {layoutError ? (
            <div
              className="explorer-layout-error"
              role="alert"
            >
              <strong>Layout failed</strong>
              <span>{layoutError}</span>
            </div>
          ) : null}

          <ReactFlow
            nodes={visibleNodes}
            edges={visibleEdges}
            fitView
            minZoom={0.05}
            maxZoom={2.5}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
          >
            <MiniMap
              pannable
              zoomable
            />
            <Controls />
            <Background gap={22} />
          </ReactFlow>
        </section>

        <aside className="explorer-detail">
          <h2>Selection</h2>
          {edgeDetail ? (
            <EdgeDetail detail={edgeDetail} />
          ) : detail ? (
            <NodeDetail
              detail={detail}
              semantic={semanticNodeDetail}
            />
          ) : (
            <p className="explorer-empty">
              Select a canonical node or edge.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function HierarchyPanel({
  hierarchy,
  scope,
  semanticModel,
  semanticScopeSummary,
  containerId,
  enabledLayerIds,
  onNavigate,
  onToggleLayer
}) {
  const current = hierarchy.containers.find(
    item => item.id === containerId
  );

  return (
    <aside className="explorer-hierarchy">
      <section>
        <h2>Layers</h2>
        <div className="explorer-layer-list">
          {hierarchy.layers.map(layer => (
            <label key={layer.id}>
              <input
                type="checkbox"
                checked={enabledLayerIds.includes(
                  layer.id
                )}
                onChange={() =>
                  onToggleLayer(layer.id)
                }
              />
              <span>{layer.label}</span>
              <small>{layer.node_ids.length}</small>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2>Hierarchy</h2>
        <nav
          className="explorer-breadcrumbs"
          aria-label="Explorer hierarchy breadcrumb"
        >
          {scope.breadcrumbs.map((item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 ? (
                <span aria-hidden="true">/</span>
              ) : null}
              <button
                type="button"
                disabled={item.id === containerId}
                onClick={() => onNavigate(item.id)}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </nav>

        {scope.child_containers.length > 0 ? (
          <div className="explorer-container-list">
            {scope.child_containers.map(item => (
              <button
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.node_count} nodes</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="explorer-empty">
            {current?.kind === 'kind'
              ? 'Canonical nodes in this kind are shown.'
              : 'No visible child containers.'}
          </p>
        )}
      </section>

      <section>
        <h2>KNEEKURA semantics</h2>
        <SemanticLegend
          semanticModel={semanticModel}
          summary={semanticScopeSummary}
        />
      </section>

      <section className="explorer-scope-stats">
        <h2>Scope</h2>
        <dl>
          <dt>Nodes</dt>
          <dd>{scope.visible_node_ids.length}</dd>
          <dt>Edges</dt>
          <dd>{scope.visible_edge_ids.length}</dd>
          <dt>Boundary edges hidden</dt>
          <dd>{scope.hidden_boundary_edge_ids.length}</dd>
        </dl>
      </section>
    </aside>
  );
}

function NodeDetail({ detail, semantic }) {
  return (
    <div className="explorer-detail-body">
      <dl>
        <dt>Label</dt>
        <dd>{detail.label}</dd>
        <dt>Canonical ID</dt>
        <dd>{detail.node_id}</dd>
        <dt>Canonical kind</dt>
        <dd>{detail.canonical_kind}</dd>
        <dt>Display family</dt>
        <dd>{detail.display_family}</dd>
        <dt>Semantic domain</dt>
        <dd>
          <SemanticBadge
            label={
              semantic?.decoration?.domain ??
              'canonical'
            }
            tone="neutral"
          />
        </dd>
        <dt>Runtime observation</dt>
        <dd>
          {semantic?.decoration
            ?.runtime_observation ?? 'n/a'}
        </dd>
        <dt>Relations</dt>
        <dd>{detail.relations.length}</dd>
        <dt>Claims</dt>
        <dd>{detail.claims.length}</dd>
        <dt>Coverage entries</dt>
        <dd>{detail.coverage.length}</dd>
      </dl>

      <h3>Canonical node</h3>
      <pre>{JSON.stringify(
        detail.canonical_node,
        null,
        2
      )}</pre>

      <h3>Relations</h3>
      <ul>
        {detail.relations.map(item => (
          <li key={item.edge_id}>
            {item.direction} · {item.canonical_type}
            {' · '}
            {item.other_node_id}
          </li>
        ))}
      </ul>

      <h3>Claim / Evidence trace</h3>
      <ul className="explorer-semantic-trace">
        {(semantic?.claims ?? []).map(item => (
          <li key={item.claim_id}>
            <div>
              <code>{item.claim_id}</code>
              {' · '}
              <SemanticBadge
                label={item.status}
                tone={item.status_tone}
              />
            </div>
            <div>{item.type}</div>
            <pre>{JSON.stringify({
              evidence_links: item.evidence_links,
              counterevidence_links:
                item.counterevidence_links,
              coverage_ref: item.coverage_ref
            }, null, 2)}</pre>
          </li>
        ))}
      </ul>

      <h3>Coverage trace</h3>
      <ul className="explorer-semantic-trace">
        {(semantic?.coverage ?? []).map(item => (
          <li key={item.coverage_id}>
            <code>{item.coverage_id}</code>
            {' · '}
            <SemanticBadge
              label={item.status}
              tone={item.status_tone}
            />
            {' · '}
            {item.role}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EdgeDetail({ detail }) {
  const semantic = detail.decoration;

  return (
    <div className="explorer-detail-body">
      <dl>
        <dt>Canonical ID</dt>
        <dd>{detail.edge_id}</dd>
        <dt>Canonical type</dt>
        <dd>{semantic.canonical_type}</dd>
        <dt>Source</dt>
        <dd>{semantic.source}</dd>
        <dt>Target</dt>
        <dd>{semantic.target}</dd>
        <dt>Semantic domain</dt>
        <dd>
          <SemanticBadge
            label={semantic.domain}
            tone="neutral"
          />
        </dd>
        <dt>Runtime observation</dt>
        <dd>
          {semantic.runtime_observation ?? 'n/a'}
        </dd>
        <dt>Transport stage</dt>
        <dd>{semantic.transport_stage ?? 'n/a'}</dd>
      </dl>

      <h3>Canonical edge</h3>
      <pre>{JSON.stringify(
        detail.canonical_edge,
        null,
        2
      )}</pre>
    </div>
  );
}

function SemanticLegend({
  semanticModel,
  summary
}) {
  return (
    <div className="explorer-semantic-legend">
      <div className="explorer-analysis-status">
        <span>Analysis</span>
        <SemanticBadge
          label={
            semanticModel.analysis.status ??
            'UNKNOWN'
          }
          tone={semanticModel.analysis.status_tone}
        />
        <small>
          unknowns {semanticModel.analysis.unknown_count}
        </small>
      </div>
      <div className="explorer-semantic-domain-list">
        {summary.node_domains.map(item => (
          <div key={item.domain}>
            <span
              className={
                'explorer-domain-dot ' +
                'explorer-domain-dot-' +
                item.domain
              }
            />
            <span>{item.domain}</span>
            <small>{item.count}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function SemanticBadge({ label, tone }) {
  return (
    <span
      className={
        'explorer-semantic-badge ' +
        'explorer-semantic-badge-' + tone
      }
    >
      {String(label)}
    </span>
  );
}
