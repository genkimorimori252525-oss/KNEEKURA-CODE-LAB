import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExplorerApp } from './App.jsx';
import './styles.css';

const root = createRoot(
  document.getElementById('root')
);

bootstrap().catch(error => {
  root.render(
    <main className="boot-error" role="alert">
      <h1>KNEEKURA Human Explorer</h1>
      <p>Explorer presentation failed.</p>
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
        'unsupported Human Experience offline payload schema'
      );
    }
    if (
      embedded.experience?.schema !==
      'kneekura.human-experience-projection/v1'
    ) {
      throw new Error(
        'offline payload is missing Human Experience projection'
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
        'projection fetch failed: ' + response.status
      );
    }
    projection = await response.json();
  }

  if (
    projection?.schema !==
    'kneekura.explorer-projection/v1'
  ) {
    throw new Error(
      'unsupported Explorer Projection schema'
    );
  }

  root.render(
    <React.StrictMode>
      <ExplorerApp
        projection={projection}
        offlinePayload={offlinePayload}
      />
    </React.StrictMode>
  );
}

function readEmbeddedExperience() {
  const node = document.getElementById(
    'kneekura-human-experience'
  );
  const raw = node?.textContent?.trim() ?? '';
  if (!raw) return null;
  if (
    raw ===
    '__KNEEKURA_HUMAN_EXPERIENCE_BASE64_V1__'
  ) {
    return null;
  }
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
      'embedded Human Experience payload is invalid: ' +
      String(error?.message ?? error)
    );
  }
}