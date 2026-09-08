import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExplorerApp } from './App.jsx';
import { SystemMapPanel } from './SystemMapPanel.jsx';
import { TechnicalViewsPanel } from './TechnicalViewsPanel.jsx';
import { RepositoryScalePanel } from './RepositoryScalePanel.jsx';
import './styles.css';
import './human-experience.css';
import './system-map.css';
import './technical-views.css';

const root = createRoot(
  document.getElementById('root')
);

bootstrap().catch(error => {
  root.render(
    <main className="boot-error" role="alert">
      <h1>KNEEKURA コードエクスプローラー</h1>
      <p>コード案内の起動に失敗しました。</p>
      <pre>{String(error?.message ?? error)}</pre>
    </main>
  );
});

async function bootstrap() {
  const embedded = readEmbeddedExperience();
  let projection;
  let offlinePayload = null;

  if (embedded) {
    if (
      embedded.schema !==
      'kneekura.human-experience-offline-payload/v1'
    ) {
      throw new Error(
        '対応していないHuman Experience成果物です。'
      );
    }
    if (
      embedded.experience?.schema !==
      'kneekura.human-experience-projection/v1'
    ) {
      throw new Error(
        'Human Experience projectionが成果物に含まれていません。'
      );
    }
    assertTechnicalViewsIdentity(embedded);
    assertRepositoryScaleIdentity(embedded);
    projection =
      embedded.experience.canonical?.explorer_projection;
    offlinePayload = embedded;
  } else {
    const response = await fetch(
      './explorer-projection.json',
      { cache: 'no-store' }
    );
    if (!response.ok) {
      throw new Error(
        'Explorer Projectionの読込に失敗しました: ' +
        response.status
      );
    }
    projection = await response.json();
  }

  if (
    projection?.schema !==
    'kneekura.explorer-projection/v1'
  ) {
    throw new Error(
      '対応していないExplorer Projectionです。'
    );
  }

  root.render(
    <React.StrictMode>
      <div className="human-explorer-r2-shell">
        <div className="human-explorer-r3-sidebar">
          <SystemMapPanel
            projection={projection}
            offlinePayload={offlinePayload}
          />
          <TechnicalViewsPanel
            projection={projection}
            offlinePayload={offlinePayload}
          />
          <RepositoryScalePanel
            offlinePayload={offlinePayload}
          />
        </div>
        <div className="human-explorer-r2-main">
          <ExplorerApp
            projection={projection}
            offlinePayload={offlinePayload}
          />
        </div>
      </div>
    </React.StrictMode>
  );
}

function assertTechnicalViewsIdentity(payload) {
  const views = payload?.technical_views;
  if (views == null) return;
  if (views.schema !== 'kneekura.human-analysis-technical-views/v1') {
    throw new Error('対応していないtechnical views成果物です。');
  }
  const experience = payload.experience;
  const presentation = payload.presentation;
  const repository = experience?.repository;
  const irDigest = experience?.source_identity?.human_analysis_ir_digest;
  if (
    !repository?.repository_id ||
    !repository?.snapshot_id ||
    !irDigest ||
    !presentation?.presentation_id
  ) {
    throw new Error('technical viewsの基準identityが不足しています。');
  }
  if (
    views.repository?.repository_id !== repository.repository_id ||
    views.repository?.snapshot_id !== repository.snapshot_id ||
    views.human_analysis_ir_digest !== irDigest ||
    views.presentation_id !== presentation.presentation_id
  ) {
    throw new Error('technical viewsのrepository/snapshot identityが一致しません。');
  }
  const authority = views.authority ?? {};
  if (
    authority.canonical_authority !== false ||
    authority.may_mint_canonical_nodes !== false ||
    authority.may_mint_canonical_edges !== false ||
    authority.may_mint_canonical_claims !== false ||
    authority.derived_presentation_only !== true
  ) {
    throw new Error('technical viewsがcanonical authority境界に違反しています。');
  }
}

function assertRepositoryScaleIdentity(payload) {
  const scale = payload?.repository_scale;
  if (scale == null) return;
  if (scale.schema !== 'kneekura.human-analysis-repository-scale/v1') {
    throw new Error('対応していないrepository-scale成果物です。');
  }
  const repository = payload.experience?.repository;
  if (
    !repository?.repository_id ||
    !repository?.snapshot_id ||
    scale.repository?.repository_id !== repository.repository_id ||
    scale.repository?.snapshot_id !== repository.snapshot_id
  ) {
    throw new Error('repository-scaleのrepository/snapshot identityが一致しません。');
  }
  if (
    scale.readiness?.repository_scale_ready !== true ||
    scale.readiness?.status !== 'READY_REPOSITORY_SCALE'
  ) {
    throw new Error('repository-scale成果物がREADYではありません。');
  }
  const authority = scale.authority ?? {};
  if (
    authority.canonical_authority !== false ||
    authority.may_mint_canonical_nodes !== false ||
    authority.may_mint_canonical_edges !== false ||
    authority.may_mint_canonical_claims !== false ||
    authority.derived_readiness_only !== true
  ) {
    throw new Error('repository-scale成果物がcanonical authority境界に違反しています。');
  }
  const authoring = payload.repository_scale_authoring_ir;
  if (
    authoring?.generation?.mode !== 'PRODUCTION' ||
    authoring?.repository?.repository_id !== repository.repository_id ||
    authoring?.repository?.snapshot_id !== repository.snapshot_id
  ) {
    throw new Error('repository-scale authoring IRのidentityが一致しません。');
  }
}

function readEmbeddedExperience() {
  const node = document.getElementById(
    'kneekura-human-experience'
  );
  const raw = node?.textContent?.trim() ?? '';
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(
      atob(raw),
      character => character.charCodeAt(0)
    );
    const payload = JSON.parse(
      new TextDecoder().decode(bytes)
    );
    node.textContent = '';
    return payload;
  } catch (error) {
    throw new Error(
      '埋め込みHuman Experienceデータを読み取れません: ' +
      String(error?.message ?? error)
    );
  }
}