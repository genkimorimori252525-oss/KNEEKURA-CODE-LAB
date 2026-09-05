import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExplorerApp } from './App.jsx';
import { HumanGuidePanel } from './HumanGuidePanel.jsx';
import './styles.css';
import './human-guide.css';
import './evidence-ux.css';

const root = createRoot(
  document.getElementById('root')
);

bootstrap().catch(error => {
  root.render(
    <main className="boot-error" role="alert">
      <h1>KNEEKURA Human Explorer</h1>
      <p>コード案内を起動できませんでした。</p>
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
        '未対応の Human Experience offline payload です。'
      );
    }
    if (
      embedded.experience?.schema !==
      'kneekura.human-experience-projection/v1'
    ) {
      throw new Error(
        'offline payload に Human Experience projection がありません。'
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
        'Explorer projection の読込に失敗しました: ' + response.status
      );
    }
    projection = await response.json();
  }

  if (
    projection?.schema !==
    'kneekura.explorer-projection/v1'
  ) {
    throw new Error(
      '未対応の Explorer Projection schema です。'
    );
  }

  root.render(
    <React.StrictMode>
      <div className="human-experience-shell">
        <HumanGuidePanel offlinePayload={offlinePayload} />
        <div className="human-experience-explorer">
          <ExplorerApp projection={projection} />
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
      '埋め込み Human Experience payload が不正です: ' +
      String(error?.message ?? error)
    );
  }
}
