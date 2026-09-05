import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExplorerApp } from './App.jsx';
import { SystemMapPanel } from './SystemMapPanel.jsx';
import './styles.css';
import './human-experience.css';
import './system-map.css';

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
        <SystemMapPanel
          projection={projection}
          offlinePayload={offlinePayload}
        />
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
    return JSON.parse(
      new TextDecoder().decode(bytes)
    );
  } catch (error) {
    throw new Error(
      '埋め込みHuman Experienceデータを読み取れません: ' +
      String(error?.message ?? error)
    );
  }
}