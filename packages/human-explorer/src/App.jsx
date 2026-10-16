import React, {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Background,
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
import {
  createExplorerGuidedTour,
  createGuidedTourPlayback,
  exitGuidedTour,
  guidedTourCurrentStep,
  moveGuidedTour,
  startGuidedTour
} from '../../../src/presentation/explorer/tour.mjs';
import {
  CHANGE_IMPACT_MAX_ITEMS,
  createExplorerChangeImpact
} from '../../../src/presentation/explorer/impact.mjs';
import {
  createExplorerConfidenceEvidenceInspector
} from '../../../src/presentation/explorer/inspector.mjs';
import {
  createOfflineHumanExperienceView
} from './offline-human-experience.mjs';

import { WorkbenchPanel } from './WorkbenchPanel.jsx';

const elk = new ELK();

export function ExplorerApp({
  projection,
  offlinePayload = null
}) {
  return (
    <ReactFlowProvider>
      <ExplorerCanvas
        projection={projection}
        offlinePayload={offlinePayload}
      />
    </ReactFlowProvider>
  );
}

function ExplorerCanvas({ projection, offlinePayload }) {
  const model = useMemo(
    () => createExplorerUiModel(projection),
    [projection]
  );
  const humanExperience = useMemo(
    () => createOfflineHumanExperienceView(offlinePayload),
    [offlinePayload]
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
  const guidedTour = useMemo(
    () => createExplorerGuidedTour(
      projection,
      model
    ),
    [projection, model]
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
  const [selectedHumanItemId, setSelectedHumanItemId] =
    useState(null);
  const [selectedHumanSourceKey, setSelectedHumanSourceKey] =
    useState(null);
  const [tourPlayback, setTourPlayback] =
    useState(() =>
      createGuidedTourPlayback(guidedTour)
    );
  const tourReturnStateRef = useRef(null);
  const [impactSeedNodeId, setImpactSeedNodeId] =
    useState(null);
  const [impactDepth, setImpactDepth] = useState(3);
  const impactReturnStateRef = useRef(null);
  const { fitView } = useReactFlow();
  const [pendingWorkbenchNodeId, setPendingWorkbenchNodeId] = useState(null);

  useEffect(() => {
    setPendingWorkbenchNodeId(null);
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(
      hierarchy.layers.map(layer => layer.id)
    );
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setTourPlayback(
      createGuidedTourPlayback(guidedTour)
    );
    tourReturnStateRef.current = null;
    setImpactSeedNodeId(null);
    setImpactDepth(3);
    impactReturnStateRef.current = null;
  }, [hierarchy, guidedTour]);

  useEffect(() => {
    const firstItem = humanExperience.items[0] ?? null;
    setSelectedHumanItemId(firstItem?.id ?? null);
    setSelectedHumanSourceKey(
      firstItem?.sources.find(
        source => source.availability !== 'UNAVAILABLE'
      )?.key ?? firstItem?.sources[0]?.key ?? null
    );
  }, [humanExperience]);

  const selectedHumanItem = useMemo(
    () => humanExperience.items.find(
      item => item.id === selectedHumanItemId
    ) ?? humanExperience.items[0] ?? null,
    [humanExperience, selectedHumanItemId]
  );
  const selectedHumanSource = useMemo(
    () => selectedHumanItem?.sources.find(
      source => source.key === selectedHumanSourceKey
    ) ?? selectedHumanItem?.sources[0] ?? null,
    [selectedHumanItem, selectedHumanSourceKey]
  );

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
  const impactModel = useMemo(
    () => impactSeedNodeId
      ? createExplorerChangeImpact(
          projection,
          model,
          impactSeedNodeId,
          {
            maxDepth: impactDepth,
            maxItems: CHANGE_IMPACT_MAX_ITEMS
          }
        )
      : null,
    [
      projection,
      model,
      impactSeedNodeId,
      impactDepth
    ]
  );
  const impactSelectedSet = useMemo(
    () => new Set(
      impactModel?.selected_node_ids ?? []
    ),
    [impactModel]
  );
  const impactBoundarySet = useMemo(
    () => new Set(
      impactModel?.boundary_node_ids ?? []
    ),
    [impactModel]
  );
  const impactCausalEdgeSet = useMemo(
    () => new Set(
      impactModel?.causal_edge_ids ?? []
    ),
    [impactModel]
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

  const currentTourStep = useMemo(
    () => guidedTourCurrentStep(
      guidedTour,
      tourPlayback
    ),
    [guidedTour, tourPlayback]
  );
  const tourHighlightSet = useMemo(
    () => new Set(
      currentTourStep?.highlight_node_ids ?? []
    ),
    [currentTourStep]
  );

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
          : null,
        tourHighlightSet.has(node.id)
          ? 'explorer-node-tour-highlight'
          : null,
        node.id === impactSeedNodeId
          ? 'explorer-node-impact-seed'
          : impactSelectedSet.has(node.id)
            ? 'explorer-node-impact-scope'
            : null,
        impactBoundarySet.has(node.id)
          ? 'explorer-node-impact-boundary'
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
    semanticNodeById,
    tourHighlightSet,
    impactSeedNodeId,
    impactSelectedSet,
    impactBoundarySet
  ]);

  const visibleEdges = useMemo(() => {
    const source = layout?.edges ?? scope.edges;
    return source.map(edge => {
      const semantic =
        semanticEdgeById.get(edge.id);
      return {
        ...edge,
        className: [
          semantic
            ? 'explorer-edge explorer-edge-domain-' +
              semantic.domain
            : 'explorer-edge',
          impactCausalEdgeSet.has(edge.id)
            ? 'explorer-edge-impact-causal'
            : null
        ].filter(Boolean).join(' '),
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
    semanticEdgeById,
    impactCausalEdgeSet
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
  const confidenceEvidenceInspector = useMemo(
    () => selectedNodeId
      ? createExplorerConfidenceEvidenceInspector(
          projection,
          selectedNodeId
        )
      : null,
    [projection, selectedNodeId]
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

  useEffect(() => {
    if (
      !layout ||
      !tourPlayback.active ||
      !currentTourStep
    ) {
      return;
    }
    const layoutNodeSet = new Set(
      layout.nodes.map(node => node.id)
    );
    const visibleHighlights =
      currentTourStep.highlight_node_ids.filter(
        nodeId =>
          visibleNodeSet.has(nodeId) &&
          layoutNodeSet.has(nodeId)
      );
    if (visibleHighlights.length === 0) {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      return;
    }
    setSelectedNodeId(visibleHighlights[0]);
    setSelectedEdgeId(null);
    queueMicrotask(() => {
      fitView({
        nodes: visibleHighlights.map(id => ({ id })),
        padding: 0.8,
        duration: 240,
        maxZoom: 1.5
      });
    });
  }, [
    layout,
    tourPlayback.active,
    tourPlayback.index,
    currentTourStep,
    visibleNodeSet,
    fitView
  ]);

  useEffect(() => {
    if (!layout || !impactModel) return;
    const layoutNodeSet = new Set(
      layout.nodes.map(node => node.id)
    );
    const visibleImpactNodes = [
      ...new Set([
        ...impactModel.selected_node_ids,
        ...impactModel.boundary_node_ids
      ])
    ].filter(
      nodeId =>
        visibleNodeSet.has(nodeId) &&
        layoutNodeSet.has(nodeId)
    );
    if (visibleImpactNodes.length === 0) return;
    queueMicrotask(() => {
      fitView({
        nodes: visibleImpactNodes.map(id => ({ id })),
        padding: 0.55,
        duration: 240,
        maxZoom: 1.25
      });
    });
  }, [
    layout,
    impactModel,
    visibleNodeSet,
    fitView
  ]);

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

  function focusWorkbenchNode(nodeId) {
    if (!model.nodes.some(node => node.id === nodeId)) return;
    // Leave temporary tours/impact overlays before selecting imported evidence.
    setTourPlayback(createGuidedTourPlayback(guidedTour));
    tourReturnStateRef.current = null;
    setImpactSeedNodeId(null);
    impactReturnStateRef.current = null;
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(hierarchy.layers.map(layer => layer.id));
    setPendingWorkbenchNodeId(nodeId);
  }

  useEffect(() => {
    if (!pendingWorkbenchNodeId || !layout ||
        !visibleNodeSet.has(pendingWorkbenchNodeId) ||
        !layout.nodes.some(node => node.id === pendingWorkbenchNodeId)) return;
    focusNode(pendingWorkbenchNodeId);
    setPendingWorkbenchNodeId(null);
  }, [pendingWorkbenchNodeId, layout, visibleNodeSet, fitView]);

  function submitSearch(event) {
    event.preventDefault();
    focusNode(matches[0] ?? null);
  }

  function prepareTourScope() {
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(
      hierarchy.layers.map(layer => layer.id)
    );
    setSelectedEdgeId(null);
  }

  function beginTour() {
    if (
      !guidedTour.has_tour ||
      impactSeedNodeId
    ) return;
    tourReturnStateRef.current = {
      containerId,
      enabledLayerIds: [...enabledLayerIds],
      selectedNodeId,
      selectedEdgeId
    };
    prepareTourScope();
    setTourPlayback(startGuidedTour(guidedTour));
  }

  function moveTour(delta) {
    prepareTourScope();
    setTourPlayback(current =>
      moveGuidedTour(
        guidedTour,
        current,
        delta
      )
    );
  }

  function endTour() {
    const restore = tourReturnStateRef.current;
    setTourPlayback(exitGuidedTour(guidedTour));
    tourReturnStateRef.current = null;
    if (!restore) return;
    setContainerId(restore.containerId);
    setEnabledLayerIds(restore.enabledLayerIds);
    setSelectedNodeId(restore.selectedNodeId);
    setSelectedEdgeId(restore.selectedEdgeId);
  }

  function prepareImpactScope() {
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(
      hierarchy.layers.map(layer => layer.id)
    );
    setSelectedEdgeId(null);
  }

  function beginImpact() {
    if (
      !selectedNodeId ||
      tourPlayback.active
    ) return;
    if (!impactSeedNodeId) {
      impactReturnStateRef.current = {
        containerId,
        enabledLayerIds: [...enabledLayerIds],
        selectedNodeId,
        selectedEdgeId
      };
    }
    prepareImpactScope();
    setImpactSeedNodeId(selectedNodeId);
  }

  function endImpact() {
    const restore = impactReturnStateRef.current;
    setImpactSeedNodeId(null);
    impactReturnStateRef.current = null;
    if (!restore) return;
    setContainerId(restore.containerId);
    setEnabledLayerIds(restore.enabledLayerIds);
    setSelectedNodeId(restore.selectedNodeId);
    setSelectedEdgeId(restore.selectedEdgeId);
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

  function selectHumanItem(itemId) {
    const item = humanExperience.items.find(
      candidate => candidate.id === itemId
    );
    setSelectedHumanItemId(itemId);
    setSelectedHumanSourceKey(
      item?.sources.find(
        source => source.availability !== 'UNAVAILABLE'
      )?.key ?? item?.sources[0]?.key ?? null
    );
  }

  return (
    <div className="explorer-shell">
      <header className="explorer-toolbar">
        <div>
          <strong>KNEEKURA コードエクスプローラー</strong>
          <span className="explorer-subtitle">
            canonical根拠とAI解釈を区別しながらコードを探索
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
            placeholder="表示中の要素・種類を検索"
            aria-label="表示中のコード要素を検索"
          />
          <button type="submit">
            最初の候補へ
          </button>
          <span aria-live="polite">
            {query ? matches.length + '件' : ''}
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
          表示範囲に合わせる
        </button>
      </header>

      <main className="explorer-main">
        <HierarchyPanel
          hierarchy={hierarchy}
          scope={scope}
          semanticModel={semanticModel}
          semanticScopeSummary={semanticScopeSummary}
          guidedTour={guidedTour}
          tourPlayback={tourPlayback}
          currentTourStep={currentTourStep}
          impactModel={impactModel}
          impactDepth={impactDepth}
          impactSeedNodeId={impactSeedNodeId}
          selectedNodeId={selectedNodeId}
          containerId={containerId}
          enabledLayerIds={enabledLayerIds}
          onNavigate={navigateContainer}
          onToggleLayer={toggleLayer}
          onTourStart={beginTour}
          onTourPrevious={() => moveTour(-1)}
          onTourNext={() => moveTour(1)}
          onTourExit={endTour}
          onImpactStart={beginImpact}
          onImpactDepthChange={setImpactDepth}
          onImpactExit={endImpact}
        />

        <section className="explorer-canvas">
          {layoutError ? (
            <div
              className="explorer-layout-error"
              role="alert"
            >
              <strong>レイアウトに失敗しました</strong>
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
            <Background gap={22} />
          </ReactFlow>
        </section>

        <aside className="explorer-detail">
          <WorkbenchPanel
            key={projection.presentation?.workbench?.report_id ?? 'no-workbench'}
            workbench={projection.presentation?.workbench}
            onSelectNode={focusWorkbenchNode}
          />
          <HumanAnalysisPanel
            view={humanExperience}
            selectedItem={selectedHumanItem}
            selectedSource={selectedHumanSource}
            onSelectItem={selectHumanItem}
            onSelectSource={setSelectedHumanSourceKey}
          />

          <h2>選択中のコード要素</h2>
          {edgeDetail ? (
            <EdgeDetail detail={edgeDetail} />
          ) : detail ? (
            <NodeDetail
              detail={detail}
              semantic={semanticNodeDetail}
              inspector={confidenceEvidenceInspector}
            />
          ) : (
            <p className="explorer-empty">
              図のコード要素か関係を選択すると、canonical情報を確認できます。
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function HumanAnalysisPanel({
  view,
  selectedItem,
  selectedSource,
  onSelectItem,
  onSelectSource
}) {
  if (!view.available) return null;

  return (
    <section className="explorer-human-analysis">
      <div>
        <h2>AIによるコード案内</h2>
        <p className="explorer-empty">
          AIの説明はcanonical事実そのものではありません。根拠を開いて実コードと照合できます。
        </p>
      </div>

      <div className="explorer-human-summary">
        <span>採用済み {view.counts.accepted}件</span>
        <span>未解決 {view.counts.unknowns}件</span>
        <span>解析範囲の不足 {view.counts.coverage_gaps}件</span>
      </div>

      {view.hidden_review_item_count > 0 ? (
        <p className="explorer-empty">
          レビューで未採用の説明 {view.hidden_review_item_count}件は通常表示から除外しています。
        </p>
      ) : null}

      {view.items.length === 0 ? (
        <p className="explorer-empty">
          採用済みのAI説明はありません。
        </p>
      ) : (
        <div className="explorer-human-items">
          {view.items.map(item => (
            <button
              type="button"
              className="explorer-human-item-button"
              key={item.id}
              aria-pressed={selectedItem?.id === item.id}
              onClick={() => onSelectItem(item.id)}
            >
              <span>{item.title}</span>
              <small>{item.semantic_label}</small>
            </button>
          ))}
        </div>
      )}

      {selectedItem ? (
        <article className="explorer-human-item">
          <div>
            <SemanticBadge
              label={selectedItem.semantic_label}
              tone={semanticClassTone(selectedItem.semantic_class)}
            />
          </div>
          <h3>{selectedItem.title}</h3>
          <p>{selectedItem.body}</p>

          <div>
            <strong>根拠</strong>
          </div>
          <div className="explorer-human-source-list">
            {selectedItem.sources.map(source =>
              source.availability === 'UNAVAILABLE' ? (
                <div
                  className="explorer-human-source-unavailable"
                  key={source.key}
                >
                  <span>{source.label}</span>
                  <span>{source.reason}</span>
                </div>
              ) : (
                <button
                  type="button"
                  key={source.key}
                  aria-pressed={selectedSource?.key === source.key}
                  onClick={() => onSelectSource(source.key)}
                >
                  {source.label}
                </button>
              )
            )}
          </div>

          <HumanSourcePanel source={selectedSource} />

          <details className="explorer-technical-details">
            <summary>技術詳細</summary>
            <pre>{JSON.stringify({
              item_id: selectedItem.id,
              stage: selectedItem.stage,
              kind: selectedItem.kind,
              semantic_class: selectedItem.semantic_class,
              review_status: selectedItem.review_status,
              review_reason: selectedItem.review_reason,
              origin: selectedItem.origin,
              source_refs: selectedItem.source_refs,
              repository: view.repository
            }, null, 2)}</pre>
          </details>
        </article>
      ) : null}
    </section>
  );
}

function HumanSourcePanel({ source }) {
  if (!source) return null;

  return (
    <section className="explorer-source-panel">
      <strong>ソース</strong>
      <div className="explorer-source-location">
        {source.label}
      </div>

      {source.availability === 'AVAILABLE' ? (
        <pre className="explorer-source-code">
          {source.rows.map(row => (
            <span className="explorer-source-line" key={row.line}>
              <span className="explorer-source-line-number">
                {row.line}
              </span>
              <span className="explorer-source-line-text">
                {row.text}
              </span>
            </span>
          ))}
        </pre>
      ) : source.availability === 'CANONICAL_RECORD' ? (
        <p className="explorer-empty">
          この根拠はコード行ではなく、canonical記録として保存されています。
        </p>
      ) : (
        <p className="explorer-human-source-unavailable">
          {source.reason}
        </p>
      )}

      <details className="explorer-technical-details">
        <summary>根拠の技術詳細</summary>
        <pre>{JSON.stringify({
          ref: source.technical_ref,
          record: source.technical_record ?? null,
          availability: source.availability
        }, null, 2)}</pre>
      </details>
    </section>
  );
}

function HierarchyPanel({
  hierarchy,
  scope,
  semanticModel,
  semanticScopeSummary,
  guidedTour,
  tourPlayback,
  currentTourStep,
  impactModel,
  impactDepth,
  impactSeedNodeId,
  selectedNodeId,
  containerId,
  enabledLayerIds,
  onNavigate,
  onToggleLayer,
  onTourStart,
  onTourPrevious,
  onTourNext,
  onTourExit,
  onImpactStart,
  onImpactDepthChange,
  onImpactExit
}) {
  const current = hierarchy.containers.find(
    item => item.id === containerId
  );

  return (
    <aside className="explorer-hierarchy">
      <section>
        <h2>変更影響</h2>
        <ChangeImpactPanel
          model={impactModel}
          depth={impactDepth}
          seedNodeId={impactSeedNodeId}
          selectedNodeId={selectedNodeId}
          tourActive={tourPlayback.active}
          onStart={onImpactStart}
          onDepthChange={onImpactDepthChange}
          onExit={onImpactExit}
        />
      </section>

      <section>
        <h2>ガイドツアー</h2>
        <GuidedTourPanel
          tour={guidedTour}
          playback={tourPlayback}
          step={currentTourStep}
          disabled={Boolean(impactSeedNodeId)}
          onStart={onTourStart}
          onPrevious={onTourPrevious}
          onNext={onTourNext}
          onExit={onTourExit}
        />
      </section>

      <section>
        <h2>表示レイヤー</h2>
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
        <h2>階層</h2>
        <nav
          className="explorer-breadcrumbs"
          aria-label="コード階層のパンくず"
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
                <small>{item.node_count}件</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="explorer-empty">
            {current?.kind === 'kind'
              ? 'この種類に属するcanonical要素を表示しています。'
              : 'この範囲に子階層はありません。'}
          </p>
        )}
      </section>

      <section>
        <h2>KNEEKURAの意味付け</h2>
        <SemanticLegend
          semanticModel={semanticModel}
          summary={semanticScopeSummary}
        />
      </section>

      <section className="explorer-scope-stats">
        <h2>現在の表示範囲</h2>
        <dl>
          <dt>要素</dt>
          <dd>{scope.visible_node_ids.length}</dd>
          <dt>関係</dt>
          <dd>{scope.visible_edge_ids.length}</dd>
          <dt>非表示の境界関係</dt>
          <dd>{scope.hidden_boundary_edge_ids.length}</dd>
        </dl>
      </section>
    </aside>
  );
}

function ChangeImpactPanel({
  model,
  depth,
  seedNodeId,
  selectedNodeId,
  tourActive,
  onStart,
  onDepthChange,
  onExit
}) {
  const active = Boolean(model && seedNodeId);

  return (
    <div className="explorer-impact-panel">
      <p className="explorer-impact-disclaimer">
        CORE IMPACTが示す調査範囲です。故障や影響が確定したという意味ではありません。
      </p>

      <label className="explorer-impact-depth">
        <span>深さ</span>
        <select
          value={depth}
          onChange={event =>
            onDepthChange(Number(event.target.value))
          }
        >
          {[1, 2, 3, 4, 5].map(value => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {!active ? (
        <>
          <button
            type="button"
            disabled={!selectedNodeId || tourActive}
            onClick={onStart}
          >
            選択中の要素を解析
          </button>
          {!selectedNodeId ? (
            <p className="explorer-empty">
              先にcanonical要素を選択してください。
            </p>
          ) : tourActive ? (
            <p className="explorer-empty">
              変更影響を調べる前にガイドツアーを終了してください。
            </p>
          ) : null}
        </>
      ) : (
        <>
          <dl>
            <dt>調査対象</dt>
            <dd>{model.selected_node_ids.length}件</dd>
            <dt>境界要素</dt>
            <dd>{model.boundary_node_ids.length}件</dd>
            <dt>因果関係</dt>
            <dd>{model.causal_edge_ids.length}件</dd>
            <dt>表示上限</dt>
            <dd>{model.max_items}件</dd>
          </dl>

          <button
            type="button"
            disabled={!selectedNodeId}
            onClick={onStart}
          >
            選択中の要素から再計算
          </button>
          <button type="button" onClick={onExit}>
            変更影響を終了
          </button>

          <details className="explorer-technical-details">
            <summary>
              技術詳細: Planner closure / boundaries
            </summary>
            <pre>{JSON.stringify({
              seed_node_id: model.seed_node_id,
              universe_enumerable:
                model.universe_enumerable,
              closure: model.closure,
              boundary: model.boundary
            }, null, 2)}</pre>
          </details>

          <details className="explorer-technical-details">
            <summary>
              技術詳細: ScopeDecision ({model.decisions.length}件)
            </summary>
            <ul className="explorer-impact-decisions">
              {model.decisions.map(item => (
                <li key={item.decision_id}>
                  <code>{item.decision_id}</code>
                  <div>
                    {item.action} · depth {item.depth}
                    {' · '}
                    {item.cause}
                  </div>
                  <div>{item.reason}</div>
                  {item.causal_edge ? (
                    <pre>{JSON.stringify(
                      item.causal_edge,
                      null,
                      2
                    )}</pre>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function GuidedTourPanel({
  tour,
  playback,
  step,
  disabled = false,
  onStart,
  onPrevious,
  onNext,
  onExit
}) {
  if (!tour.has_tour) {
    return (
      <p className="explorer-empty">
        このgraphにはcanonicalガイドツアーがありません。
      </p>
    );
  }

  if (!playback.active || !step) {
    return (
      <div className="explorer-tour-panel">
        <p>
          canonicalツアーを{tour.step_count}手順利用できます。
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={onStart}
        >
          ツアーを開始
        </button>
        {disabled ? (
          <p className="explorer-empty">
            ツアーを始める前に変更影響を終了してください。
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="explorer-tour-panel"
      aria-live="polite"
    >
      <div className="explorer-tour-progress">
        手順 {playback.index + 1} / {tour.step_count}
      </div>
      <h3>{step.label}</h3>
      {step.description ? (
        <p>{step.description}</p>
      ) : null}
      {step.language_lesson ? (
        <div className="explorer-tour-lesson">
          <strong>言語メモ</strong>
          <p>{step.language_lesson}</p>
        </div>
      ) : null}
      <dl>
        <dt>強調対象</dt>
        <dd>{step.highlight_node_ids.length}件</dd>
      </dl>
      {step.highlight_node_ids.length === 0 ? (
        <p className="explorer-empty">
          この手順には強調対象がありません。
        </p>
      ) : null}
      <div className="explorer-tour-actions">
        <button
          type="button"
          disabled={playback.index === 0}
          onClick={onPrevious}
        >
          前へ
        </button>
        <button
          type="button"
          disabled={
            playback.index === tour.step_count - 1
          }
          onClick={onNext}
        >
          次へ
        </button>
        <button type="button" onClick={onExit}>
          終了
        </button>
      </div>
      <details className="explorer-technical-details">
        <summary>技術詳細</summary>
        <pre>{JSON.stringify({
          canonical_step: step.step_node_id,
          highlight_node_ids: step.highlight_node_ids
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

function NodeDetail({ detail, semantic, inspector }) {
  return (
    <div className="explorer-detail-body">
      <dl>
        <dt>名前</dt>
        <dd>{detail.label}</dd>
        <dt>canonical種類</dt>
        <dd>{detail.canonical_kind}</dd>
        <dt>表示分類</dt>
        <dd>{detail.display_family}</dd>
        <dt>意味領域</dt>
        <dd>
          <SemanticBadge
            label={domainLabel(
              semantic?.decoration?.domain ??
              'canonical'
            )}
            tone="neutral"
          />
        </dd>
        <dt>実行時の観測</dt>
        <dd>
          {semantic?.decoration
            ?.runtime_observation ?? '記録なし'}
        </dd>
        <dt>関係</dt>
        <dd>{detail.relations.length}件</dd>
        <dt>主張</dt>
        <dd>{detail.claims.length}件</dd>
        <dt>解析範囲記録</dt>
        <dd>{detail.coverage.length}件</dd>
      </dl>

      <h3>関係</h3>
      {detail.relations.length ? (
        <ul>
          {detail.relations.map(item => (
            <li key={item.edge_id}>
              {relationDirectionLabel(item.direction)}
              {' · '}
              {item.canonical_type}
            </li>
          ))}
        </ul>
      ) : (
        <p className="explorer-empty">関係記録はありません。</p>
      )}

      <h3>主張と根拠</h3>
      {(semantic?.claims ?? []).length ? (
        <ul className="explorer-semantic-trace">
          {semantic.claims.map(item => (
            <li key={item.claim_id}>
              <div>
                <SemanticBadge
                  label={statusLabel(item.status)}
                  tone={item.status_tone}
                />
              </div>
              <div>{item.type}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="explorer-empty">canonical主張はありません。</p>
      )}

      <ConfidenceEvidenceInspector
        inspector={inspector}
      />

      <h3>解析範囲</h3>
      {(semantic?.coverage ?? []).length ? (
        <ul className="explorer-semantic-trace">
          {semantic.coverage.map(item => (
            <li key={item.coverage_id}>
              <SemanticBadge
                label={statusLabel(item.status)}
                tone={item.status_tone}
              />
              {' · '}
              {item.role}
            </li>
          ))}
        </ul>
      ) : (
        <p className="explorer-empty">解析範囲記録はありません。</p>
      )}

      <details className="explorer-technical-details">
        <summary>技術詳細</summary>
        <pre>{JSON.stringify({
          canonical_id: detail.node_id,
          canonical_node: detail.canonical_node,
          relations: detail.relations,
          claims: semantic?.claims ?? [],
          coverage: semantic?.coverage ?? []
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

function ConfidenceEvidenceInspector({
  inspector
}) {
  if (!inspector) return null;

  return (
    <section className="explorer-confidence-inspector">
      <h3>信頼度と根拠</h3>
      <p className="explorer-inspector-disclaimer">
        canonicalに保存された項目だけを表示します。独自の点数付けや順位付けはしません。
      </p>

      {inspector.claims.length === 0 ? (
        <p className="explorer-empty">
          この要素にcanonical主張は結び付いていません。
        </p>
      ) : (
        <div className="explorer-inspector-claims">
          {inspector.claims.map(claim => (
            <article
              key={claim.claim_id}
              className="explorer-inspector-claim"
            >
              <div className="explorer-inspector-heading">
                <strong>{claim.type}</strong>
                <SemanticBadge
                  label={statusLabel(claim.status)}
                  tone="neutral"
                />
              </div>

              <dl>
                <dt>信頼度</dt>
                <dd>{claim.confidence.level}</dd>
                <dt>信頼度の理由</dt>
                <dd>{claim.confidence.rationale}</dd>
                <dt>述語</dt>
                <dd>{claim.predicate}</dd>
                <dt>対象 / 値</dt>
                <dd>
                  <pre>{JSON.stringify(
                    claim.object_or_value,
                    null,
                    2
                  )}</pre>
                </dd>
                <dt>解析範囲</dt>
                <dd>
                  {statusLabel(claim.coverage.status)}
                  {' · '}
                  {claim.coverage.role}
                </dd>
                <dt>検証結果</dt>
                <dd>{claim.verifier_results.length}件</dd>
              </dl>

              {claim.unresolved_reason ? (
                <div className="explorer-inspector-note">
                  <strong>未解決の理由</strong>
                  <p>{claim.unresolved_reason}</p>
                </div>
              ) : null}

              <EvidenceLinkGroup
                title="根拠"
                items={claim.evidence_links}
              />
              <EvidenceLinkGroup
                title="反証"
                items={claim.counterevidence_links}
              />

              <details className="explorer-technical-details">
                <summary>技術詳細</summary>
                <pre>{JSON.stringify({
                  claim_id: claim.claim_id,
                  coverage_id: claim.coverage.id,
                  dependency_claim_ids:
                    claim.dependency_claim_ids,
                  provenance_refs: claim.provenance_refs,
                  verifier_results: claim.verifier_results
                }, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}

      <details className="explorer-technical-details">
        <summary>
          技術詳細: 要素のCoverage ({inspector.node_coverage.length}件)
        </summary>
        <pre>{JSON.stringify(
          inspector.node_coverage,
          null,
          2
        )}</pre>
      </details>
    </section>
  );
}

function EvidenceLinkGroup({
  title,
  items
}) {
  return (
    <div className="explorer-inspector-evidence-group">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="explorer-empty">なし</p>
      ) : (
        <ul>
          {items.map(item => (
            <li
              key={
                item.source_field + ':' +
                item.canonical_link_index + ':' +
                item.link.evidence_id
              }
            >
              <div>
                {item.link.role}
                {' · '}
                {item.link.strength}
              </div>
              {item.link.rationale ? (
                <p>{item.link.rationale}</p>
              ) : null}

              {item.record_status === 'INLINE' ? (
                <p className="explorer-empty">
                  根拠記録を成果物内に同梱しています。
                </p>
              ) : (
                <p className="explorer-inspector-unavailable">
                  根拠本文はこの成果物へ直接同梱されていません。canonical参照は保持されており、根拠が存在しないという意味ではありません。
                </p>
              )}

              <details className="explorer-technical-details">
                <summary>根拠の技術詳細</summary>
                <pre>{JSON.stringify({
                  evidence_id: item.link.evidence_id,
                  link: item.link,
                  record_status: item.record_status,
                  evidence: item.evidence ?? null
                }, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EdgeDetail({ detail }) {
  const semantic = detail.decoration;

  return (
    <div className="explorer-detail-body">
      <dl>
        <dt>canonical種類</dt>
        <dd>{semantic.canonical_type}</dd>
        <dt>意味領域</dt>
        <dd>
          <SemanticBadge
            label={domainLabel(semantic.domain)}
            tone="neutral"
          />
        </dd>
        <dt>実行時の観測</dt>
        <dd>
          {semantic.runtime_observation ?? '記録なし'}
        </dd>
        <dt>通信段階</dt>
        <dd>{semantic.transport_stage ?? '記録なし'}</dd>
      </dl>

      <details className="explorer-technical-details">
        <summary>技術詳細</summary>
        <pre>{JSON.stringify({
          canonical_id: detail.edge_id,
          source: semantic.source,
          target: semantic.target,
          canonical_edge: detail.canonical_edge
        }, null, 2)}</pre>
      </details>
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
        <span>解析状態</span>
        <SemanticBadge
          label={statusLabel(
            semanticModel.analysis.status ??
            'UNKNOWN'
          )}
          tone={semanticModel.analysis.status_tone}
        />
        <small>
          未解決 {semanticModel.analysis.unknown_count}件
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
            <span>{domainLabel(item.domain)}</span>
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

function semanticClassTone(value) {
  if (value === 'COVERAGE_GAP') return 'limited';
  if (value === 'UNKNOWN') return 'unknown';
  return 'analyzed';
}

function relationDirectionLabel(value) {
  switch (String(value ?? '').toUpperCase()) {
    case 'INCOMING':
      return 'この要素へ向かう関係';
    case 'OUTGOING':
      return 'この要素から向かう関係';
    default:
      return String(value ?? '関係');
  }
}

function domainLabel(value) {
  switch (String(value ?? '').toLowerCase()) {
    case 'source':
      return 'ソース';
    case 'forge':
      return 'Forge';
    case 'network':
      return '通信';
    case 'runtime':
      return '実行時';
    case 'molang':
      return 'Molang';
    case 'animation':
      return 'アニメーション';
    case 'bone':
      return 'ボーン';
    case 'resource':
      return 'リソース';
    case 'semantic':
      return '意味解析';
    case 'external':
      return '外部境界';
    case 'canonical':
      return 'canonical';
    default:
      return String(value ?? '不明');
  }
}

function statusLabel(value) {
  switch (String(value ?? '').toUpperCase()) {
    case 'UNKNOWN':
      return '未確認';
    case 'FAILED':
      return '失敗';
    case 'UNEXPLORED':
      return '未探索';
    case 'COVERAGE_GAP':
      return '解析範囲不足';
    case 'VERIFIED':
      return '検証済み';
    case 'ANALYZED':
      return '解析済み';
    case 'LIMITED':
      return '限定的';
    default:
      return String(value ?? '不明');
  }
}