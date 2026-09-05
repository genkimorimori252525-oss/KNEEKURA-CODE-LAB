import React, { useMemo, useState } from 'react';

import {
  createExplorerUiModel
} from '../../../src/presentation/explorer/ui-model.mjs';
import {
  CHANGE_IMPACT_MAX_ITEMS,
  createExplorerChangeImpact
} from '../../../src/presentation/explorer/impact.mjs';
import {
  createHumanExplorerSystemMap,
  resolveHumanExplorerSelection,
  searchHumanExplorerSystemMap,
  SYSTEM_MAP_AUTHORITY
} from './system-map.mjs';

const LEVEL_PREVIEW_LIMIT = 80;
const CHILD_PREVIEW_LIMIT = 60;

export function SystemMapPanel({ projection, offlinePayload }) {
  const systemMap = useMemo(
    () => createHumanExplorerSystemMap({ projection, offlinePayload }),
    [projection, offlinePayload]
  );
  const canonicalModel = useMemo(
    () => createExplorerUiModel(projection),
    [projection]
  );
  const [selectionId, setSelectionId] = useState('system:root');
  const [sourceKey, setSourceKey] = useState(null);
  const [query, setQuery] = useState('');
  const [impactDepth, setImpactDepth] = useState(3);

  const selection = useMemo(
    () => resolveHumanExplorerSelection(systemMap, selectionId, sourceKey) ??
      resolveHumanExplorerSelection(systemMap, 'system:root'),
    [systemMap, selectionId, sourceKey]
  );
  const searchResults = useMemo(
    () => searchHumanExplorerSystemMap(systemMap, query, { limit: 80 }),
    [systemMap, query]
  );
  const impact = useMemo(
    () => selection?.can_change_impact
      ? createExplorerChangeImpact(
          projection,
          canonicalModel,
          selection.canonical_node_id,
          { maxDepth: impactDepth, maxItems: CHANGE_IMPACT_MAX_ITEMS }
        )
      : null,
    [projection, canonicalModel, selection, impactDepth]
  );

  const entityById = useMemo(
    () => new Map(systemMap.entities.map(entity => [entity.selection_id, entity])),
    [systemMap]
  );

  function selectEntity(nextId) {
    const next = resolveHumanExplorerSelection(systemMap, nextId);
    if (!next) return;
    setSelectionId(nextId);
    setSourceKey(next.selected_source?.key ?? null);
  }

  function openTourStep(step) {
    const target = step.target_selection_ids[0];
    if (target) selectEntity(target);
  }

  const entity = selection?.entity;
  const children = (entity?.child_ids ?? [])
    .map(id => entityById.get(id))
    .filter(Boolean)
    .slice(0, CHILD_PREVIEW_LIMIT);
  const parents = (entity?.parent_ids ?? [])
    .map(id => entityById.get(id))
    .filter(Boolean);

  return (
    <aside className="system-map-panel" aria-label="R2 System Map">
      <header className="system-map-header">
        <div>
          <strong>System Map</strong>
          <span>L0–L3・共通selection/source resolver</span>
        </div>
        <span className="system-map-level-badge">L{entity?.level ?? 0}</span>
      </header>

      <section className="system-map-section">
        <h2>リポジトリ全体を検索</h2>
        <input
          className="system-map-search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="component / package / file / symbol / source"
          aria-label="System Mapのリポジトリ全体を検索"
        />
        {query ? (
          <div className="system-map-search-results" role="list">
            {searchResults.length ? searchResults.map(result => (
              <button
                type="button"
                key={result.selection_id}
                onClick={() => selectEntity(result.selection_id)}
              >
                <span>{result.label}</span>
                <small>
                  L{result.level} · {kindLabel(result.kind)} · {authorityLabel(result.authority)}
                </small>
                {result.path ? <code>{result.path}</code> : null}
              </button>
            )) : (
              <p className="system-map-muted">該当する要素はありません。</p>
            )}
          </div>
        ) : null}
      </section>

      <section className="system-map-section">
        <h2>L0–L3 探索</h2>
        <div className="system-map-levels">
          {systemMap.levels.map(level => {
            const entries = systemMap.entities.filter(
              candidate => candidate.level === level.level
            );
            return (
              <details key={level.level} open={level.level === entity?.level}>
                <summary>
                  L{level.level} {level.label} ({entries.length})
                </summary>
                <div className="system-map-level-items">
                  {entries.slice(0, LEVEL_PREVIEW_LIMIT).map(candidate => (
                    <button
                      type="button"
                      key={candidate.selection_id}
                      aria-pressed={candidate.selection_id === entity?.selection_id}
                      onClick={() => selectEntity(candidate.selection_id)}
                    >
                      <span>{candidate.label}</span>
                      <small>{kindLabel(candidate.kind)}</small>
                    </button>
                  ))}
                </div>
                {entries.length > LEVEL_PREVIEW_LIMIT ? (
                  <p className="system-map-muted">
                    先頭{LEVEL_PREVIEW_LIMIT}件を表示。全件は上のリポジトリ検索から探せます。
                  </p>
                ) : null}
              </details>
            );
          })}
        </div>
      </section>

      {entity ? (
        <section className="system-map-section system-map-selection">
          <div className="system-map-selection-heading">
            <div>
              <span className="system-map-kicker">L{entity.level} {kindLabel(entity.kind)}</span>
              <h2>{entity.label}</h2>
            </div>
            <AuthorityBadge authority={entity.authority} />
          </div>
          {entity.description ? <p>{entity.description}</p> : null}
          {entity.path ? <code className="system-map-path">{entity.path}</code> : null}

          {parents.length ? (
            <div className="system-map-links">
              <strong>上へ</strong>
              {parents.map(parent => (
                <button
                  type="button"
                  key={parent.selection_id}
                  onClick={() => selectEntity(parent.selection_id)}
                >
                  {parent.label}
                </button>
              ))}
            </div>
          ) : null}

          {children.length ? (
            <div className="system-map-links">
              <strong>中を見る</strong>
              {children.map(child => (
                <button
                  type="button"
                  key={child.selection_id}
                  onClick={() => selectEntity(child.selection_id)}
                >
                  {child.label}
                  <small>L{child.level} · {kindLabel(child.kind)}</small>
                </button>
              ))}
            </div>
          ) : null}

          <SourceResolverView
            selection={selection}
            onSelectSource={setSourceKey}
          />

          <details className="system-map-technical">
            <summary>selectionの技術詳細</summary>
            <pre>{JSON.stringify({
              selection_id: selection.selection_id,
              authority: selection.authority,
              canonical_node_id: selection.canonical_node_id,
              human_item_ids: selection.human_item_ids,
              source_keys: entity.source_keys
            }, null, 2)}</pre>
          </details>
        </section>
      ) : null}

      <section className="system-map-section">
        <h2>ガイドツアー</h2>
        {systemMap.tours.length ? systemMap.tours.map(tour => (
          <details key={tour.tour_id} open>
            <summary>
              {tour.kind === 'CANONICAL' ? 'canonical' : 'AI著述'} · {tour.label}
            </summary>
            <ol className="system-map-tour">
              {tour.steps.map(step => (
                <li key={step.step_id}>
                  <button
                    type="button"
                    disabled={step.target_selection_ids.length === 0}
                    onClick={() => openTourStep(step)}
                  >
                    {step.label}
                  </button>
                  {step.body ? <p>{step.body}</p> : null}
                </li>
              ))}
            </ol>
          </details>
        )) : (
          <p className="system-map-muted">利用できるツアーはありません。</p>
        )}
      </section>

      <section className="system-map-section">
        <h2>変更影響</h2>
        {selection?.can_change_impact ? (
          <>
            <p className="system-map-muted">
              このselectionは実canonical nodeに対応しています。既存CORE IMPACTだけを使用します。
            </p>
            <label className="system-map-impact-depth">
              <span>深さ</span>
              <select
                value={impactDepth}
                onChange={event => setImpactDepth(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5].map(value => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <dl className="system-map-impact-stats">
              <dt>調査対象</dt><dd>{impact?.selected_node_ids.length ?? 0}</dd>
              <dt>境界</dt><dd>{impact?.boundary_node_ids.length ?? 0}</dd>
              <dt>因果関係</dt><dd>{impact?.causal_edge_ids.length ?? 0}</dd>
            </dl>
          </>
        ) : (
          <p className="system-map-muted">
            source-only / AI由来entityからcanonical Change Impactは捏造しません。実canonical nodeを選択した場合だけ有効になります。
          </p>
        )}
      </section>

      <footer className="system-map-footer">
        canonical {systemMap.stats.canonical_entities} · AI/derived {systemMap.stats.derived_presentation_entities} · source-only {systemMap.stats.source_only_entities}
      </footer>
    </aside>
  );
}

function SourceResolverView({ selection, onSelectSource }) {
  if (!selection?.sources.length) {
    return (
      <p className="system-map-muted">
        このselectionに直接結び付いたsource rangeはありません。
      </p>
    );
  }
  const selected = selection.selected_source ?? selection.sources[0];
  return (
    <div className="system-map-source-resolver">
      <strong>共通source resolver</strong>
      <div className="system-map-source-buttons">
        {selection.sources.map(source => (
          <button
            type="button"
            key={source.key}
            aria-pressed={selected?.key === source.key}
            onClick={() => onSelectSource(source.key)}
          >
            {source.label}
          </button>
        ))}
      </div>
      {selected?.availability === 'AVAILABLE' ? (
        <pre className="system-map-source-code" aria-label={`${selected.label} のソース`}>
          {selected.rows.map(row => (
            <span key={row.line} className="system-map-source-row">
              <span className="system-map-source-line">{row.line}</span>
              <span>{row.text || ' '}</span>
            </span>
          ))}
        </pre>
      ) : (
        <p className="system-map-muted">
          {selected?.availability === 'CANONICAL_RECORD'
            ? 'コード行ではなくcanonical recordとして利用できます。'
            : 'source本文はこの成果物に同梱されていません。'}
        </p>
      )}
    </div>
  );
}

function AuthorityBadge({ authority }) {
  return (
    <span className={`system-map-authority system-map-authority-${String(authority).toLowerCase()}`}>
      {authorityLabel(authority)}
    </span>
  );
}

function authorityLabel(authority) {
  switch (authority) {
    case SYSTEM_MAP_AUTHORITY.CANONICAL:
      return 'canonical';
    case SYSTEM_MAP_AUTHORITY.DERIVED_PRESENTATION:
      return 'AI/derived';
    case SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY:
      return 'source-only';
    default:
      return String(authority ?? 'unknown');
  }
}

function kindLabel(kind) {
  return ({
    SYSTEM: 'System',
    COMPONENT: 'Component',
    DOMAIN: 'Domain',
    PACKAGE: 'Package',
    FILE: 'File',
    SYMBOL: 'Symbol',
    SOURCE: 'Source'
  })[kind] ?? String(kind ?? 'Unknown');
}