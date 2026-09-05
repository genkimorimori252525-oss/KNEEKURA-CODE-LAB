import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = fs.readFileSync(
  path.join(ROOT, 'packages/human-explorer/src/App.jsx'),
  'utf8'
);
const MAIN = fs.readFileSync(
  path.join(ROOT, 'packages/human-explorer/src/main.jsx'),
  'utf8'
);

const OLD_VISIBLE_UI = [
  '<h2>Selection</h2>',
  '<h2>Change impact</h2>',
  '<h2>Guided tour</h2>',
  '<h2>Layers</h2>',
  '<h2>Hierarchy</h2>',
  '<h2>KNEEKURA semantics</h2>',
  '<h2>Scope</h2>',
  '<strong>Layout failed</strong>',
  '<span>Depth</span>',
  '<dt>Canonical ID</dt>',
  '<dt>Canonical step</dt>',
  '<strong>Language lesson</strong>'
];

test('Human Explorer receives offline payload and exposes Japanese explanation/source surface', () => {
  assert.match(MAIN, /offlinePayload=\{offlinePayload\}/);
  assert.match(APP, /createOfflineHumanExperienceView\(offlinePayload\)/);
  assert.match(APP, /AIによるコード案内/);
  assert.match(APP, /<strong>根拠<\/strong>/);
  assert.match(APP, /<strong>ソース<\/strong>/);
  assert.match(APP, /source\.rows\.map/);
  assert.match(APP, /根拠の技術詳細/);
});

test('old English UI labels and default Canonical ID labels are absent', () => {
  for (const text of OLD_VISIBLE_UI) {
    assert.equal(
      APP.includes(text),
      false,
      `old visible UI remained: ${text}`
    );
  }
  assert.equal(
    MAIN.includes('Explorer presentation failed.'),
    false
  );
});

test('raw traceability remains available only through explicit technical-detail surfaces', () => {
  assert.match(APP, /<summary>技術詳細<\/summary>/);
  assert.match(APP, /canonical_id: detail\.node_id/);
  assert.match(APP, /claim_id: claim\.claim_id/);
  assert.match(APP, /evidence_id: item\.link\.evidence_id/);
  assert.match(APP, /ref: source\.technical_ref/);
});

test('review-rejected Human Analysis items are filtered before normal rendering', () => {
  const VIEW_MODEL = fs.readFileSync(
    path.join(
      ROOT,
      'packages/human-explorer/src/offline-human-experience.mjs'
    ),
    'utf8'
  );
  assert.match(
    VIEW_MODEL,
    /filter\(item => item\.review_status === 'ACCEPT'\)/
  );
  assert.match(APP, /レビューで未採用の説明/);
});