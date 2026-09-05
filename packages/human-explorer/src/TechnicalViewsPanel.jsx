import React, { useMemo, useState } from 'react';

import {
  createHumanExplorerSystemMap,
  resolveHumanExplorerSelection
} from './system-map.mjs';

export function TechnicalViewsPanel({ projection, offlinePayload }) {
  const views = offlinePayload?.technical_views ?? null;
  const systemMap = useMemo(
    () => createHumanExplorerSystemMap({ projection, offlinePayload }),
    [projection, offlinePayload]
  );
  const [selected, setSelected] = useState(null);
  if (!views) return null;

  const presentation = offlinePayload?.presentation;
  const componentById = new Map(
    (presentation?.components ?? []).map(item => [item.component_id, item])
  );
  const stepById = new Map(
    (views.workflow?.steps ?? []).map(item => [item.step_id, item])
  );

  function openSource(ref) {
    const key = sourceKey(ref);
    const entity = systemMap.entities.find(item => item.source_keys.includes(key));
    if (!entity) {
      setSelected({ unavailable: true, key, ref });
      return;
    }
    const resolved = resolveHumanExplorerSelection(systemMap, entity.selection_id, key);
    setSelected(resolved ?? { unavailable: true, key, ref });
  }

  return (
    <section className="technical-views-panel" aria-label="R3 technical views">
      <header className="technical-views-header">
        <strong>技術ビュー</strong>
        <span>Architecture / Workflow / Sequence / Data Flow / Lifecycle</span>
      </header>

      <ViewSection title="Architecture">
        <h3>{views.architecture.title}</h3>
        <div className="technical-component-list">
          {views.architecture.component_ids.map(id => (
            <div key={id}>
              <strong>{componentById.get(id)?.name ?? id}</strong>
              <small>{componentById.get(id)?.responsibility ?? ''}</small>
            </div>
          ))}
        </div>
        <RelationList
          rows={views.architecture.relations}
          renderLabel={row => `${componentById.get(row.from_component_id)?.name ?? row.from_component_id} → ${componentById.get(row.to_component_id)?.name ?? row.to_component_id} · ${row.type} · ${row.direction}`}
          onOpenSource={openSource}
        />
      </ViewSection>

      <ViewSection title="Workflow">
        <h3>{views.workflow.title}</h3>
        <ol className="technical-step-list">
          {views.workflow.steps.map(step => <li key={step.step_id}>{step.label}</li>)}
        </ol>
        <RelationList
          rows={views.workflow.transitions}
          renderLabel={row => `${stepById.get(row.from_step_id)?.label ?? row.from_step_id} → ${stepById.get(row.to_step_id)?.label ?? row.to_step_id} · ${row.kind}`}
          onOpenSource={openSource}
        />
      </ViewSection>

      <ViewSection title="Sequence">
        <h3>{views.sequence.title}</h3>
        <div className="technical-relation-list">
          {views.sequence.messages.map(message => (
            <article key={message.message_id}>
              <div>
                <Confirmation row={message} />
                <strong>{message.order == null ? '順序未確認' : `#${message.order}`}</strong>
              </div>
              <p>{stepById.get(message.from_step_id)?.label ?? message.from_step_id} → {stepById.get(message.to_step_id)?.label ?? message.to_step_id}</p>
              <p>{message.label}</p>
              <EvidenceButtons refs={message.source_refs} onOpen={openSource} />
              <Unconfirmed row={message} />
            </article>
          ))}
        </div>
      </ViewSection>

      <ViewSection title="Data Flow">
        <h3>{views.data_flow.title}</h3>
        <RelationList
          rows={views.data_flow.transfers}
          renderLabel={row => `${stepById.get(row.from_step_id)?.label ?? row.from_step_id} → ${stepById.get(row.to_step_id)?.label ?? row.to_step_id} · ${row.label} · ${row.direction}`}
          onOpenSource={openSource}
        />
      </ViewSection>

      <ViewSection title="Lifecycle">
        <h3>{views.lifecycle.title}</h3>
        <div className="technical-state-list">
          {views.lifecycle.states.map(state => (
            <div key={state.state_id}>
              <strong>{state.label}</strong>
              <EvidenceButtons refs={state.source_refs} onOpen={openSource} />
            </div>
          ))}
        </div>
        <RelationList
          rows={views.lifecycle.transitions}
          renderLabel={row => `${stateLabel(views.lifecycle.states, row.from_state_id)} → ${stateLabel(views.lifecycle.states, row.to_state_id)} · ${row.label}`}
          onOpenSource={openSource}
        />
      </ViewSection>

      <SourceResolution resolved={selected} />

      <details className="technical-views-details">
        <summary>技術詳細</summary>
        <pre>{JSON.stringify({
          schema: views.schema,
          view_set_id: views.view_set_id,
          authority: views.authority,
          repository: views.repository
        }, null, 2)}</pre>
      </details>
    </section>
  );
}

function ViewSection({ title, children }) {
  return <details className="technical-view-section"><summary>{title}</summary>{children}</details>;
}

function RelationList({ rows, renderLabel, onOpenSource }) {
  return (
    <div className="technical-relation-list">
      {rows.length ? rows.map((row, index) => (
        <article key={row.relation_id ?? row.transfer_id ?? row.transition_id ?? `${index}`}>
          <Confirmation row={row} />
          <p>{renderLabel(row)}</p>
          <EvidenceButtons refs={row.source_refs ?? []} onOpen={onOpenSource} />
          <Unconfirmed row={row} />
        </article>
      )) : <p className="technical-muted">このviewに関係記録はありません。</p>}
    </div>
  );
}

function Confirmation({ row }) {
  return (
    <span className={`technical-confirmation technical-confirmation-${String(row.confirmation).toLowerCase()}`}>
      {row.confirmation === 'CONFIRMED' ? '根拠確認済み' : '未確認'}
    </span>
  );
}

function Unconfirmed({ row }) {
  if (row.confirmation !== 'UNCONFIRMED') return null;
  return <p className="technical-unconfirmed">未確認理由: {row.unconfirmed_reason}</p>;
}

function EvidenceButtons({ refs, onOpen }) {
  if (!refs?.length) return null;
  return (
    <div className="technical-source-buttons">
      {refs.map(ref => (
        <button type="button" key={sourceKey(ref)} onClick={() => onOpen(ref)}>
          {sourceLabel(ref)}
        </button>
      ))}
    </div>
  );
}

function SourceResolution({ resolved }) {
  if (!resolved) return null;
  if (resolved.unavailable) {
    return <p className="technical-unconfirmed">この根拠は共有source resolverで直接表示できません。</p>;
  }
  const source = resolved.selected_source ?? resolved.sources?.[0] ?? null;
  if (!source) return <p className="technical-muted">このselectionに表示可能なsourceはありません。</p>;
  return (
    <section className="technical-source-resolution">
      <strong>共有source resolver</strong>
      <div>{source.label}</div>
      {source.availability === 'AVAILABLE' ? (
        <pre>
          {source.rows.map(row => (
            <span key={row.line}><span>{row.line}</span><span>{row.text || ' '}</span></span>
          ))}
        </pre>
      ) : (
        <p className="technical-muted">{source.reason ?? source.availability}</p>
      )}
    </section>
  );
}

function stateLabel(states, id) {
  return states.find(state => state.state_id === id)?.label ?? id;
}

function sourceLabel(ref) {
  return String(ref.kind).toUpperCase() === 'FILE_RANGE'
    ? `${ref.path}:${ref.start_line}${ref.start_line === ref.end_line ? '' : `–${ref.end_line}`}`
    : `${ref.kind}:${ref.id}`;
}

function sourceKey(ref) {
  return String(ref.kind).toUpperCase() === 'FILE_RANGE'
    ? ['FILE_RANGE', String(ref.path).replaceAll('\\', '/'), Number(ref.start_line), Number(ref.end_line), String(ref.content_digest ?? '').toLowerCase()].join(':')
    : `${String(ref.kind).toUpperCase()}:${String(ref.id ?? '')}`;
}