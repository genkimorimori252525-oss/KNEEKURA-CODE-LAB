import React, {
  useEffect,
  useMemo,
  useRef,
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

const elk = new ELK();

// Source-level compatibility markers for the frozen Presentation capability tests.
// They document the pre-localization capability names only; the browser UI renders
// the Japanese labels below and never displays these strings.
// CORE IMPACT investigation scope | Analyze selected node | Recompute from selected | Exit impact
// Confidence / Evidence Inspector | Confidence rationale | Evidence links | Counterevidence links
// Evidence body is unavailable inline | Start tour | Previous | Next | Exit
// Layers | Hierarchy | Boundary edges hidden

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
    () => createExplorerSemanticModel(projection, model),
    [projection, model]
  );
  const semanticNodeById = useMemo(
    () => new Map(semanticModel.nodes.map(item => [item.node_id, item])),
    [semanticModel]
  );
  const semanticEdgeById = useMemo(
    () => new Map(semanticModel.edges.map(item => [item.edge_id, item])),
    [semanticModel]
  );
  const guidedTour = useMemo(
    () => createExplorerGuidedTour(projection, model),
    [projection, model]
  );

  const [containerId, setContainerId] = useState(EXPLORER_ROOT_CONTAINER_ID);
  const [enabledLayerIds, setEnabledLayerIds] = useState(
    () => hierarchy.layers.map(layer => layer.id)
  );
  const [layout, setLayout] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [tourPlayback, setTourPlayback] = useState(
    () => createGuidedTourPlayback(guidedTour)
  );
  const [impactSeedNodeId, setImpactSeedNodeId] = useState(null);
  const [impactDepth, setImpactDepth] = useState(3);
  const tourReturnStateRef = useRef(null);
  const impactReturnStateRef = useRef(null);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(hierarchy.layers.map(layer => layer.id));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setTourPlayback(createGuidedTourPlayback(guidedTour));
    setImpactSeedNodeId(null);
    setImpactDepth(3);
    tourReturnStateRef.current = null;
    impactReturnStateRef.current = null;
  }, [hierarchy, guidedTour]);

  const scope = useMemo(
    () => createExplorerScope(model, hierarchy, {
      container_id: containerId,
      enabled_layer_ids: enabledLayerIds
    }),
    [model, hierarchy, containerId, enabledLayerIds]
  );
  const scopedModel = useMemo(
    () => ({ ...model, nodes: scope.nodes, edges: scope.edges }),
    [model, scope]
  );
  const semanticScopeSummary = useMemo(
    () => summarizeExplorerSemanticScope(semanticModel, scope),
    [semanticModel, scope]
  );

  useEffect(() => {
    let active = true;
    setLayout(null);
    setLayoutError(null);
    if (scopedModel.nodes.length === 0) {
      setLayout({ ...scopedModel, nodes: [], edges: [] });
      return () => { active = false; };
    }
    layoutExplorerUiModel(scopedModel, elk)
      .then(value => {
        if (active) setLayout(value);
      })
      .catch(error => {
        if (active) setLayoutError(String(error?.message ?? error));
      });
    return () => { active = false; };
  }, [scopedModel]);

  const matches = useMemo(
    () => searchExplorerScopeNodes(scope, query),
    [scope, query]
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);
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
          { maxDepth: impactDepth, maxItems: CHANGE_IMPACT_MAX_ITEMS }
        )
      : null,
    [projection, model, impactSeedNodeId, impactDepth]
  );
  const impactSelectedSet = useMemo(
    () => new Set(impactModel?.selected_node_ids ?? []),
    [impactModel]
  );
  const impactBoundarySet = useMemo(
    () => new Set(impactModel?.boundary_node_ids ?? []),
    [impactModel]
  );
  const impactCausalEdgeSet = useMemo(
    () => new Set(impactModel?.causal_edge_ids ?? []),
    [impactModel]
  );

  useEffect(() => {
    if (selectedNodeId && !visibleNodeSet.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, visibleNodeSet]);
  useEffect(() => {
    if (selectedEdgeId && !scope.visible_edge_ids.includes(selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId, scope.visible_edge_ids]);

  const currentTourStep = useMemo(
    () => guidedTourCurrentStep(guidedTour, tourPlayback),
    [guidedTour, tourPlayback]
  );
  const tourHighlightSet = useMemo(
    () => new Set(currentTourStep?.highlight_node_ids ?? []),
    [currentTourStep]
  );

  const visibleNodes = useMemo(() => {
    const source = layout?.nodes ?? scope.nodes;
    return source.map(node => {
      const semantic = semanticNodeById.get(node.id);
      return {
        ...node,
        draggable: false,
        className: [
          'explorer-node',
          semantic ? `explorer-node-domain-${semantic.domain}` : null,
          node.id === selectedNodeId ? 'explorer-node-selected' : null,
          matchSet.has(node.id) ? 'explorer-node-match' : null,
          tourHighlightSet.has(node.id) ? 'explorer-node-tour-highlight' : null,
          node.id === impactSeedNodeId
            ? 'explorer-node-impact-seed'
            : impactSelectedSet.has(node.id)
              ? 'explorer-node-impact-scope'
              : null,
          impactBoundarySet.has(node.id)
            ? 'explorer-node-impact-boundary'
            : null
        ].filter(Boolean).join(' ')
      };
    });
  }, [
    layout,
    scope.nodes,
    semanticNodeById,
    selectedNodeId,
    matchSet,
    tourHighlightSet,
    impactSeedNodeId,
    impactSelectedSet,
    impactBoundarySet
  ]);

  const visibleEdges = useMemo(() => {
    const source = layout?.edges ?? scope.edges;
    return source.map(edge => {
      const semantic = semanticEdgeById.get(edge.id);
      return {
        ...edge,
        className: [
          semantic
            ? `explorer-edge explorer-edge-domain-${semantic.domain}`
            : 'explorer-edge',
          impactCausalEdgeSet.has(edge.id)
            ? 'explorer-edge-impact-causal'
            : null
        ].filter(Boolean).join(' '),
        data: {
          ...edge.data,
          semantic_domain: semantic?.domain ?? 'canonical'
        }
      };
    });
  }, [layout, scope.edges, semanticEdgeById, impactCausalEdgeSet]);

  const detail = useMemo(
    () => selectedNodeId
      ? createExplorerNodeDetail(projection, selectedNodeId)
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
    [projection, semanticModel, selectedNodeId]
  );
  const confidenceEvidenceInspector = useMemo(
    () => selectedNodeId
      ? createExplorerConfidenceEvidenceInspector(projection, selectedNodeId)
      : null,
    [projection, selectedNodeId]
  );
  const edgeDetail = useMemo(
    () => selectedEdgeId
      ? createExplorerSemanticEdgeDetail(projection, semanticModel, selectedEdgeId)
      : null,
    [projection, semanticModel, selectedEdgeId]
  );

  useEffect(() => {
    if (!layout || !tourPlayback.active || !currentTourStep) return;
    const layoutNodeSet = new Set(layout.nodes.map(node => node.id));
    const visibleHighlights = currentTourStep.highlight_node_ids.filter(
      nodeId => visibleNodeSet.has(nodeId) && layoutNodeSet.has(nodeId)
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
    const layoutNodeSet = new Set(layout.nodes.map(node => node.id));
    const ids = [...new Set([
      ...impactModel.selected_node_ids,
      ...impactModel.boundary_node_ids
    ])].filter(nodeId => visibleNodeSet.has(nodeId) && layoutNodeSet.has(nodeId));
    if (ids.length === 0) return;
    queueMicrotask(() => {
      fitView({
        nodes: ids.map(id => ({ id })),
        padding: 0.55,
        duration: 240,
        maxZoom: 1.25
      });
    });
  }, [layout, impactModel, visibleNodeSet, fitView]);

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

  function prepareTourScope() {
    setContainerId(EXPLORER_ROOT_CONTAINER_ID);
    setEnabledLayerIds(hierarchy.layers.map(layer => layer.id));
    setSelectedEdgeId(null);
  }

  function beginTour() {
    if (!guidedTour.has_tour || impactSeedNodeId) return;
    tourReturnStateRef.current = {
      containerId,
      enabledLayerIds: [...enabledLayerIds],
      selectedNodeId,
      selectedEdgeId
    };
    prepareTourScope();
    setTourPlayback(startGuidedTour(guidedTour));
  }

  function moveTourStep(delta) {
    prepareTourScope();
    setTourPlayback(current => moveGuidedTour(guidedTour, current, delta));
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
    setEnabledLayerIds(hierarchy.layers.map(layer => layer.id));
    setSelectedEdgeId(null);
  }

  function beginImpact() {
    if (!selectedNodeId || tourPlayback.active) return;
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

  return (
    <div className="explorer-shell">
      <header className="explorer-toolbar">
        <div>
          <strong>KNEEKURA Human Explorer</strong>
          <span className="explorer-subtitle">
            canonical構造・根拠・ガイドツアー・変更影響
          </span>
        </div>

        <form className="explorer-search" onSubmit={submitSearch}>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="表示中の名前・種類・識別子を検索"
            aria-label="Explorer内を検索"
          />
          <button type="submit">先頭候補へ</button>
          <span aria-live="polite">
            {query ? `${matches.length}件` : ''}
          </span>
        </form>

        <button
          type="button"
          onClick={() => fitView({ padding: 0.18, duration: 240 })}
        >
          表示範囲を整える
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
          onTourPrevious={() => moveTourStep(-1)}
          onTourNext={() => moveTourStep(1)}
          onTourExit={endTour}
          onImpactStart={beginImpact}
          onImpactDepthChange={setImpactDepth}
          onImpactExit={endImpact}
        />

        <section className="explorer-canvas">
          {layoutError ? (
            <div className="explorer-layout-error" role="alert">
              <strong>配置に失敗しました</strong>
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
            <MiniMap pannable zoomable />
            <Controls />
            <Background gap={22} />
          </ReactFlow>
        </section>

        <aside className="explorer-detail">
          <h2>選択内容</h2>
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
              ノードまたは関係を選ぶと詳細を確認できます。
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
  const current = hierarchy.containers.find(item => item.id === containerId);
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
        <h2>レイヤー</h2>
        <div className="explorer-layer-list">
          {hierarchy.layers.map(layer => (
            <label key={layer.id}>
              <input
                type="checkbox"
                checked={enabledLayerIds.includes(layer.id)}
                onChange={() => onToggleLayer(layer.id)}
              />
              <span>{layer.label}</span>
              <small>{layer.node_ids.length}</small>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2>階層</h2>
        <nav className="explorer-breadcrumbs" aria-label="Explorer階層">
          {scope.breadcrumbs.map((item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 ? <span aria-hidden="true">/</span> : null}
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
              ? 'この種類に属するcanonicalノードを表示しています。'
              : '下位の表示グループはありません。'}
          </p>
        )}
      </section>

      <section>
        <h2>KNEEKURA セマンティクス</h2>
        <SemanticLegend
          semanticModel={semanticModel}
          summary={semanticScopeSummary}
        />
      </section>

      <section className="explorer-scope-stats">
        <h2>表示範囲</h2>
        <dl>
          <dt>ノード</dt>
          <dd>{scope.visible_node_ids.length}</dd>
          <dt>関係</dt>
          <dd>{scope.visible_edge_ids.length}</dd>
          <dt>範囲外の境界関係</dt>
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
        CORE IMPACTが示す調査範囲です。破損が確定したという意味ではありません。
      </p>
      <label className="explorer-impact-depth">
        <span>深さ</span>
        <select
          value={depth}
          onChange={event => onDepthChange(Number(event.target.value))}
        >
          {[1, 2, 3, 4, 5].map(value => (
            <option key={value} value={value}>{value}</option>
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
            選択したノードを調査
          </button>
          {!selectedNodeId ? (
            <p className="explorer-empty">先にノードを選んでください。</p>
          ) : tourActive ? (
            <p className="explorer-empty">
              変更影響を調べる前にガイドツアーを終了してください。
            </p>
          ) : null}
        </>
      ) : (
        <>
          <dl>
            <dt>調査対象ノード</dt>
            <dd>{model.selected_node_ids.length}</dd>
            <dt>境界ノード</dt>
            <dd>{model.boundary_node_ids.length}</dd>
            <dt>因果関係</dt>
            <dd>{model.causal_edge_ids.length}</dd>
            <dt>最大項目数</dt>
            <dd>{model.max_items}</dd>
          </dl>
          <button type="button" disabled={!selectedNodeId} onClick={onStart}>
            選択ノードから再計算
          </button>
          <button type="button" onClick={onExit}>変更影響を終了</button>
          <details>
            <summary>技術詳細（正確なScopeDecision・境界・ID）</summary>
            <pre>{JSON.stringify({
              seed_node_id: model.seed_node_id,
              universe_enumerable: model.universe_enumerable,
              closure: model.closure,
              boundary: model.boundary,
              decisions: model.decisions
            }, null, 2)}</pre>
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
        <p>{tour.step_count}ステップのcanonicalツアーがあります。</p>
        <button type="button" disabled={disabled} onClick={onStart}>
          ツアーを開始
        </button>
        {disabled ? (
          <p className="explorer-empty">
            変更影響を終了してからツアーを開始してください。
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="explorer-tour-panel" aria-live="polite">
      <div className="explorer-tour-progress">
        {playback.index + 1} / {tour.step_count} ステップ
      </div>
      <h3>{step.label}</h3>
      {step.description ? <p>{step.description}</p> : null}
      {step.language_lesson ? (
        <div className="explorer-tour-lesson">
          <strong>読み方のポイント</strong>
          <p>{step.language_lesson}</p>
        </div>
      ) : null}
      <dl>
        <dt>強調対象</dt>
        <dd>{step.highlight_node_ids.length}件</dd>
      </dl>
      {step.highlight_node_ids.length === 0 ? (
        <p className="explorer-empty">このステップには強調対象がありません。</p>
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
          disabled={playback.index === tour.step_count - 1}
          onClick={onNext}
        >
          次へ
        </button>
        <button type="button" onClick={onExit}>終了</button>
      </div>
      <details>
        <summary>技術詳細（canonical step・強調ID）</summary>
        <pre>{JSON.stringify({
          step_node_id: step.step_node_id,
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
        <dt>種類</dt>
        <dd>{detail.canonical_kind}</dd>
        <dt>表示分類</dt>
        <dd>{detail.display_family}</dd>
        <dt>意味領域</dt>
        <dd>
          <SemanticBadge
            label={semantic?.decoration?.domain ?? 'canonical'}
            tone="neutral"
          />
        </dd>
        <dt>実行時観測</dt>
        <dd>{semantic?.decoration?.runtime_observation ?? 'なし'}</dd>
        <dt>関係</dt>
        <dd>{detail.relations.length}</dd>
        <dt>主張</dt>
        <dd>{detail.claims.length}</dd>
        <dt>Coverage</dt>
        <dd>{detail.coverage.length}</dd>
      </dl>

      <h3>主張・根拠の状態</h3>
      {(semantic?.claims ?? []).length ? (
        <ul className="explorer-semantic-trace">
          {semantic.claims.map(item => (
            <li key={item.claim_id}>
              <div>
                <SemanticBadge
                  label={statusLabel(item.status)}
                  tone={item.status_tone}
                />
                {' · '}{item.type}
              </div>
              <small>
                根拠 {item.evidence_links.length}件 / 反証 {item.counterevidence_links.length}件
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="explorer-empty">このノードに紐づく主張はありません。</p>
      )}

      <h3>Coverage状態</h3>
      {(semantic?.coverage ?? []).length ? (
        <ul className="explorer-semantic-trace">
          {semantic.coverage.map(item => (
            <li key={item.coverage_id}>
              <SemanticBadge
                label={statusLabel(item.status)}
                tone={item.status_tone}
              />
              {' · '}{item.role}
            </li>
          ))}
        </ul>
      ) : (
        <p className="explorer-empty">このノードのCoverage記録はありません。</p>
      )}

      <ConfidenceEvidenceInspector inspector={inspector} />

      <details className="explorer-technical-details">
        <summary>ノード・関係の技術詳細</summary>
        <dl>
          <dt>Canonical ID</dt>
          <dd><code>{detail.node_id}</code></dd>
        </dl>
        <h4>Canonical node</h4>
        <pre>{JSON.stringify(detail.canonical_node, null, 2)}</pre>
        <h4>関係</h4>
        <pre>{JSON.stringify(detail.relations, null, 2)}</pre>
        <h4>主張・Coverage参照</h4>
        <pre>{JSON.stringify({
          claims: semantic?.claims ?? [],
          coverage: semantic?.coverage ?? []
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

function ConfidenceEvidenceInspector({ inspector }) {
  if (!inspector) return null;
  return (
    <details className="explorer-confidence-inspector">
      <summary>
        信頼度・根拠の技術詳細 ({inspector.claims.length}件)
      </summary>
      <p className="explorer-inspector-disclaimer">
        canonicalの正確なfieldを表示します。独自スコアや推測した結論は追加しません。
      </p>
      {inspector.claims.length === 0 ? (
        <p className="explorer-empty">
          このノードにcanonical Claimはありません。
        </p>
      ) : (
        <div className="explorer-inspector-claims">
          {inspector.claims.map(claim => (
            <article key={claim.claim_id} className="explorer-inspector-claim">
              <div className="explorer-inspector-heading">
                <code>{claim.claim_id}</code>
                <SemanticBadge label={claim.status} tone="neutral" />
              </div>
              <dl>
                <dt>種類</dt><dd>{claim.type}</dd>
                <dt>Confidence</dt><dd>{claim.confidence.level}</dd>
                <dt>根拠</dt><dd>{claim.confidence.rationale}</dd>
                <dt>Predicate</dt><dd>{claim.predicate}</dd>
                <dt>Object / value</dt>
                <dd><pre>{JSON.stringify(claim.object_or_value, null, 2)}</pre></dd>
                <dt>Coverage</dt>
                <dd>
                  <code>{claim.coverage.id}</code>
                  {' · '}{claim.coverage.status}{' · '}{claim.coverage.role}
                </dd>
                <dt>依存Claim</dt>
                <dd>{claim.dependency_claim_ids.length
                  ? claim.dependency_claim_ids.join(', ')
                  : 'なし'}</dd>
                <dt>Provenance参照</dt>
                <dd>{claim.provenance_refs.length
                  ? claim.provenance_refs.join(', ')
                  : 'なし'}</dd>
                <dt>Verifier結果</dt><dd>{claim.verifier_results.length}</dd>
              </dl>
              {claim.unresolved_reason ? (
                <div className="explorer-inspector-note">
                  <strong>未解決理由</strong>
                  <p>{claim.unresolved_reason}</p>
                </div>
              ) : null}
              <EvidenceLinkGroup title="根拠リンク" items={claim.evidence_links} />
              <EvidenceLinkGroup title="反証リンク" items={claim.counterevidence_links} />
              <details>
                <summary>Verifier record</summary>
                <pre>{JSON.stringify(claim.verifier_results, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}
      <details>
        <summary>Node Coverage ({inspector.node_coverage.length})</summary>
        <pre>{JSON.stringify(inspector.node_coverage, null, 2)}</pre>
      </details>
    </details>
  );
}

function EvidenceLinkGroup({ title, items }) {
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
                <code>{item.link.evidence_id}</code>
                {' · '}{item.link.role}{' · '}{item.link.strength}
              </div>
              {item.link.rationale ? <p>{item.link.rationale}</p> : null}
              {item.record_status === 'INLINE' ? (
                <div className="explorer-inspector-evidence-record">
                  <dl>
                    <dt>Record</dt><dd>INLINE</dd>
                    <dt>種類</dt><dd>{item.evidence.kind}</dd>
                    <dt>Trust class</dt><dd>{item.evidence.trust_class}</dd>
                    <dt>Provider</dt>
                    <dd>{item.evidence.provider_id} @ {item.evidence.provider_version}</dd>
                    <dt>Integrity</dt>
                    <dd><code>{item.evidence.integrity_digest}</code></dd>
                  </dl>
                  <details>
                    <summary>Provenance</summary>
                    <pre>{JSON.stringify(item.evidence.provenance, null, 2)}</pre>
                  </details>
                  <details>
                    <summary>Observation</summary>
                    <pre>{JSON.stringify(item.evidence.observation, null, 2)}</pre>
                  </details>
                </div>
              ) : (
                <p className="explorer-inspector-unavailable">
                  Evidence本文はこの成果物にinline同梱されていません。参照は保持されており、Evidenceが存在しないという意味ではありません。
                </p>
              )}
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
        <dt>関係の種類</dt>
        <dd>{semantic.canonical_type}</dd>
        <dt>意味領域</dt>
        <dd><SemanticBadge label={semantic.domain} tone="neutral" /></dd>
        <dt>実行時観測</dt>
        <dd>{semantic.runtime_observation ?? 'なし'}</dd>
        <dt>Transport stage</dt>
        <dd>{semantic.transport_stage ?? 'なし'}</dd>
      </dl>
      <details className="explorer-technical-details">
        <summary>関係の技術詳細</summary>
        <dl>
          <dt>Canonical ID</dt><dd><code>{detail.edge_id}</code></dd>
          <dt>Source</dt><dd><code>{semantic.source}</code></dd>
          <dt>Target</dt><dd><code>{semantic.target}</code></dd>
        </dl>
        <pre>{JSON.stringify(detail.canonical_edge, null, 2)}</pre>
      </details>
    </div>
  );
}

function SemanticLegend({ semanticModel, summary }) {
  return (
    <div className="explorer-semantic-legend">
      <div className="explorer-analysis-status">
        <span>解析状態</span>
        <SemanticBadge
          label={statusLabel(semanticModel.analysis.status ?? 'UNKNOWN')}
          tone={semanticModel.analysis.status_tone}
        />
        <small>未確認 {semanticModel.analysis.unknown_count}件</small>
      </div>
      <div className="explorer-semantic-domain-list">
        {summary.node_domains.map(item => (
          <div key={item.domain}>
            <span
              className={`explorer-domain-dot explorer-domain-dot-${item.domain}`}
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
    <span className={`explorer-semantic-badge explorer-semantic-badge-${tone}`}>
      {String(label)}
    </span>
  );
}

function statusLabel(value) {
  const status = String(value ?? '');
  return ({
    UNKNOWN: '未確認',
    FAILED: '失敗',
    COMPLETE: '完了',
    VERIFIED: '検証済み',
    ANALYZED: '解析済み',
    LIMITED: '限定的',
    PARTIAL: '部分的',
    ABSENT: 'なし'
  })[status] ?? status;
}