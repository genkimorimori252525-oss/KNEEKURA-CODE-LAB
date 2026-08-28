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
  createExplorerUiModel,
  searchExplorerNodes
} from '../../../src/presentation/explorer/ui-model.mjs';
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
  const [layout, setLayout] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] =
    useState(null);
  const { fitView } = useReactFlow();

  useEffect(() => {
    let active = true;
    setLayout(null);
    setLayoutError(null);

    layoutExplorerUiModel(model, elk)
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
  }, [model]);

  const matches = useMemo(
    () => searchExplorerNodes(model, query),
    [model, query]
  );
  const matchSet = useMemo(
    () => new Set(matches),
    [matches]
  );

  const visibleNodes = useMemo(() => {
    const source = layout?.nodes ?? model.nodes;
    return source.map(node => ({
      ...node,
      draggable: false,
      className: node.id === selectedNodeId
        ? 'explorer-node explorer-node-selected'
        : matchSet.has(node.id)
          ? 'explorer-node explorer-node-match'
          : 'explorer-node'
    }));
  }, [layout, model.nodes, matchSet, selectedNodeId]);

  const visibleEdges = useMemo(
    () => layout?.edges ?? model.edges,
    [layout, model.edges]
  );

  const detail = useMemo(
    () => selectedNodeId
      ? createExplorerNodeDetail(
          projection,
          selectedNodeId
        )
      : null,
    [projection, selectedNodeId]
  );

  function focusNode(nodeId) {
    if (!nodeId) return;
    setSelectedNodeId(nodeId);
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

  return (
    <div className="explorer-shell">
      <header className="explorer-toolbar">
        <div>
          <strong>KNEEKURA Human Explorer</strong>
          <span className="explorer-subtitle">
            P2 shell · canonical projection consumer
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
            placeholder="node / kind / id を検索"
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
          Fit graph
        </button>
      </header>

      <main className="explorer-main">
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
            onNodeClick={(_, node) =>
              setSelectedNodeId(node.id)
            }
            onPaneClick={() =>
              setSelectedNodeId(null)
            }
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
          {detail ? (
            <NodeDetail detail={detail} />
          ) : (
            <p className="explorer-empty">
              Select a canonical node.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function NodeDetail({ detail }) {
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

      <h3>Claims</h3>
      <ul>
        {detail.claims.map(item => (
          <li key={item.claim_id}>
            {item.claim_id} · {item.type}
            {' · '}
            {item.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
