import React, { useMemo, useState } from 'react';

import {
  createOfflineExperienceViewModel
} from './offline-experience.mjs';

export function HumanGuidePanel({ offlinePayload }) {
  const model = useMemo(
    () => createOfflineExperienceViewModel(offlinePayload),
    [offlinePayload]
  );
  const [selectedItemId, setSelectedItemId] = useState(
    () => model.explanations[0]?.id ?? null
  );
  const [selectedSourceKey, setSelectedSourceKey] = useState(null);

  if (!model.available) {
    return (
      <aside className="human-guide human-guide-unavailable">
        <h2>コード案内</h2>
        <p>
          この表示にはAI著述のオフライン説明が含まれていません。
          既存のcanonical Explorerのみ利用できます。
        </p>
      </aside>
    );
  }

  const selectedItem =
    model.explanations.find(item => item.id === selectedItemId) ??
    model.explanations[0] ?? null;
  const selectedSource = selectedItem?.sources.find(
    source => source.key === selectedSourceKey
  ) ?? null;

  function selectItem(itemId) {
    setSelectedItemId(itemId);
    setSelectedSourceKey(null);
  }

  return (
    <aside className="human-guide" aria-label="AIによるコード案内">
      <header className="human-guide-header">
        <div>
          <strong>コード案内</strong>
          <span>AI著述・根拠優先</span>
        </div>
        <span className="human-guide-badge">AIによる解釈</span>
      </header>

      <section className="human-guide-section">
        <h2>このリポジトリの説明</h2>
        {model.explanations.length ? (
          <div className="human-guide-item-list">
            {model.explanations.map(item => (
              <button
                key={item.id}
                type="button"
                className={
                  item.id === selectedItem?.id
                    ? 'human-guide-item human-guide-item-selected'
                    : 'human-guide-item'
                }
                onClick={() => selectItem(item.id)}
              >
                {item.title}
              </button>
            ))}
          </div>
        ) : (
          <p className="human-guide-muted">
            採用済みの主要説明はまだありません。
          </p>
        )}
      </section>

      {selectedItem ? (
        <section className="human-guide-section human-guide-explanation">
          <div className="human-guide-heading-row">
            <h2>{selectedItem.title}</h2>
            <span className="human-guide-badge">AIによる解釈</span>
          </div>
          <p className="human-guide-body">{selectedItem.body}</p>

          <h3>根拠・ソース</h3>
          {selectedItem.sources.length ? (
            <div className="human-guide-source-links">
              {selectedItem.sources.map(source => (
                <button
                  key={source.key}
                  type="button"
                  onClick={() => setSelectedSourceKey(source.key)}
                  aria-pressed={selectedSource?.key === source.key}
                >
                  {sourceButtonLabel(source)}
                </button>
              ))}
            </div>
          ) : (
            <p className="human-guide-warning">
              この説明には参照可能な根拠がありません。
            </p>
          )}

          {selectedSource ? (
            <SourcePanel source={selectedSource} />
          ) : (
            <p className="human-guide-muted">
              引用を選ぶと、同梱されたコードまたは根拠recordを確認できます。
            </p>
          )}

          <details className="human-guide-technical">
            <summary>技術詳細</summary>
            <pre>{JSON.stringify({
              item_id: selectedItem.id,
              kind: selectedItem.kind,
              semantic_class: selectedItem.semantic_class,
              review_status: selectedItem.review_status,
              ...selectedItem.technical
            }, null, 2)}</pre>
          </details>
        </section>
      ) : null}

      <section className="human-guide-section">
        <details className="human-guide-uncertainty">
          <summary>
            未確認・解析範囲 ({model.uncertainties.length})
          </summary>
          {model.uncertainties.length ? (
            <ul>
              {model.uncertainties.map(item => (
                <li key={item.id}>
                  <strong>
                    {item.semantic_class === 'UNKNOWN'
                      ? '未確認'
                      : '解析範囲の不足'}
                  </strong>
                  <span>{item.title}</span>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="human-guide-muted">
              採用済みの未確認事項・coverage gapはありません。
            </p>
          )}
        </details>
      </section>

      <details className="human-guide-technical human-guide-artifact-technical">
        <summary>成果物の技術詳細</summary>
        <pre>{JSON.stringify({
          ...model.technical,
          rejected_item_count: model.rejected_count,
          unreviewed_item_count: model.unreviewed_count
        }, null, 2)}</pre>
      </details>
    </aside>
  );
}

function SourcePanel({ source }) {
  return (
    <section className="human-guide-source-panel" aria-live="polite">
      <div className="human-guide-heading-row">
        <h3>{source.citation}</h3>
        <SourceState source={source} />
      </div>

      {source.availability === 'INLINE_SOURCE' ? (
        <div
          className="human-guide-code"
          role="region"
          aria-label={`${source.citation} のソースコード`}
        >
          {source.lines.map(line => (
            <div className="human-guide-code-line" key={line.line_number}>
              <span className="human-guide-line-number" aria-hidden="true">
                {line.line_number}
              </span>
              <code>{line.text || ' '}</code>
            </div>
          ))}
        </div>
      ) : source.availability === 'CANONICAL_RECORD' ? (
        <p className="human-guide-muted">
          canonicalな根拠recordです。行本文は推測せず、必要な識別情報は技術詳細に保持しています。
        </p>
      ) : (
        <p className="human-guide-warning">
          {source.unavailable_reason}
        </p>
      )}

      <details className="human-guide-technical">
        <summary>根拠の技術詳細</summary>
        <pre>{JSON.stringify({
          reference_type: source.reference_type,
          record: source.record ?? null,
          ...source.technical
        }, null, 2)}</pre>
      </details>
    </section>
  );
}

function SourceState({ source }) {
  const label = source.availability === 'INLINE_SOURCE'
    ? 'ソース同梱済み'
    : source.availability === 'CANONICAL_RECORD'
      ? source.reference_type === 'RUNTIME_OBSERVATION'
        ? '実行時観測記録'
        : '根拠record'
      : 'ソース未同梱';
  return <span className="human-guide-source-state">{label}</span>;
}

function sourceButtonLabel(source) {
  if (source.reference_type === 'FILE_RANGE') return source.citation;
  if (source.reference_type === 'RUNTIME_OBSERVATION') {
    return `${source.citation}（実行時観測）`;
  }
  return `${source.citation}（根拠record）`;
}