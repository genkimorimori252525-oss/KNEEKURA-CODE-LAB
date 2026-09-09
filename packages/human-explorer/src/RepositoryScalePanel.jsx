import React from 'react';

export function RepositoryScalePanel({ offlinePayload }) {
  const scale = offlinePayload?.repository_scale;
  const authoring = offlinePayload?.repository_scale_authoring_ir;
  if (!scale || !authoring) return null;
  const accepted = new Set(authoring.review?.accepted_item_ids ?? []);
  const domainItems = (authoring.items ?? []).filter(item =>
    item.stage === 'DOMAIN' && accepted.has(item.id)
  );
  const byBatch = new Map(domainItems.map(item => [
    item.metadata?.repository_scale_batch_id,
    item
  ]));
  return (
    <aside className="system-map-panel" aria-label="R4 repository-scale readiness">
      <header className="system-map-header">
        <div>
          <strong>リポジトリ規模の解析</strong>
          <span>inventory・domain batch・integration review</span>
        </div>
        <span className="system-map-level-badge">R4</span>
      </header>
      <section className="system-map-section">
        <h2>Repository-scale readiness</h2>
        <p><strong>{scale.readiness.repository_scale_ready ? 'READY' : 'NOT READY'}</strong></p>
        <dl className="system-map-impact-stats">
          <dt>inventory</dt><dd>{scale.inventory.total_files} files</dd>
          <dt>domain batches</dt><dd>{scale.batches.length}</dd>
          <dt>scanner coverage</dt><dd>{percent(scale.coverage.scanner.ratio)}</dd>
          <dt>AI direct-read coverage</dt><dd>{percent(scale.coverage.ai_read.ratio)}</dd>
          <dt>offline source coverage</dt><dd>{percent(scale.coverage.offline_source.ratio)}</dd>
        </dl>
        <p className="system-map-muted">
          AI direct-read coverageは「AIが全ファイルを読んだ」割合ではありません。各domain batchの代表sourceを直接読んだ実測範囲を、scanner coverageやoffline availabilityと分離して表示しています。
        </p>
      </section>
      <section className="system-map-section">
        <h2>Domain batches</h2>
        {scale.batches.map(batch => {
          const item = byBatch.get(batch.batch_id);
          return (
            <details key={batch.batch_id}>
              <summary>{batch.domain} · {batch.paths.length} files · {batch.status}</summary>
              {item ? <><strong>{item.title}</strong><p>{item.body}</p></> : null}
              <code className="system-map-path">
                representative: {item?.metadata?.representative_path ?? batch.direct_ai_read_paths[0] ?? '未確認'}
              </code>
              <p className="system-map-muted">
                この解釈は代表sourceに限定され、batch内の未読fileへ一般化しません。代表pathは上の「リポジトリ全体を検索」から探索できます。
              </p>
            </details>
          );
        })}
      </section>
      <section className="system-map-section">
        <h2>Replay / performance gate</h2>
        <dl className="system-map-impact-stats">
          <dt>integration review</dt><dd>{scale.integration_review.status}</dd>
          <dt>budget profile</dt><dd>{scale.performance.budget_profile}</dd>
          <dt>npm lock</dt><dd>{scale.replay_lock.lockfile_digest ? 'pinned' : 'missing'}</dd>
        </dl>
      </section>
    </aside>
  );
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : 'n/a';
}