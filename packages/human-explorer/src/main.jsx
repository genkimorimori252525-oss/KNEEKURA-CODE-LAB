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
  const response = await fetch(
    '/explorer-projection.json',
    { cache: 'no-store' }
  );
  if (!response.ok) {
    throw new Error(
      'projection fetch failed: ' + response.status
    );
  }

  const projection = await response.json();
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
      <ExplorerApp projection={projection} />
    </React.StrictMode>
  );
}
