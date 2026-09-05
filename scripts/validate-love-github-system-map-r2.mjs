import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createHumanExplorerSystemMap,
  resolveHumanExplorerSelection,
  searchHumanExplorerSystemMap,
  SYSTEM_MAP_AUTHORITY
} from '../packages/human-explorer/src/system-map.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'r1-love-github-production');

// Reuse the exact fixed-snapshot PRODUCTION R1 generation path. This does not
// re-author semantics; it deterministically replays the saved AI authoring run
// and rebuilds the current Human Explorer shell/artifact.
await import('./run-love-github-human-guide-production-r1.mjs');

const [experience, sources, presentation, projection] = await Promise.all([
  readJson('experience.json'),
  readJson('sources.json'),
  readJson('presentation.json'),
  readJson('explorer-projection.json')
]);

const offlinePayload = {
  schema: 'kneekura.human-experience-offline-payload/v1',
  experience,
  sources,
  presentation
};
const model = createHumanExplorerSystemMap({
  projection,
  offlinePayload
});

const catalogFiles = experience.source_index?.files ?? [];
assert(catalogFiles.length > 0, 'R2 real repository source catalog is empty');
assert.equal(
  model.stats.source_catalog_files,
  catalogFiles.length,
  'R2 System Map must index every source-catalog file'
);

const materializedPaths = new Set(
  (sources.records ?? [])
    .filter(record => String(record?.ref?.kind ?? '').toUpperCase() === 'FILE_RANGE')
    .map(record => String(record.ref.path))
);
const catalogOnly = catalogFiles.find(entry => !materializedPaths.has(entry.path));
assert(
  catalogOnly,
  'R2 real proof requires at least one catalog file that was not materialized as an AI source range'
);
assert(
  catalogFiles.length > materializedPaths.size,
  'R2 repository-wide catalog must be broader than the saved AI source reads'
);

const catalogOnlyResult = searchHumanExplorerSystemMap(
  model,
  catalogOnly.path,
  { limit: 500 }
).find(result =>
  result.kind === 'FILE' && result.path === catalogOnly.path
);
assert(
  catalogOnlyResult,
  `R2 repository-wide search did not find catalog-only file: ${catalogOnly.path}`
);
const catalogOnlySelection = resolveHumanExplorerSelection(
  model,
  catalogOnlyResult.selection_id
);
assert(catalogOnlySelection);
assert.equal(
  catalogOnlySelection.authority,
  SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY
);
assert.equal(catalogOnlySelection.canonical_node_id, null);
assert.equal(catalogOnlySelection.can_change_impact, false);
assert.equal(
  catalogOnlySelection.sources.length,
  0,
  'catalog-only file must not pretend source text was materialized'
);

const aiTour = model.tours.find(tour => tour.kind === 'AI_AUTHORED');
assert(aiTour, 'R2 real Love-Github artifact is missing the AI-authored tour');
assert(aiTour.steps.length > 0, 'R2 AI-authored tour has no steps');
const aiTargetId = aiTour.steps
  .flatMap(step => step.target_selection_ids)
  .find(Boolean);
assert(aiTargetId, 'R2 AI-authored tour has no resolvable target');
const aiTarget = resolveHumanExplorerSelection(model, aiTargetId);
assert(aiTarget, 'R2 AI-authored tour target cannot be resolved');
assert.equal(
  aiTarget.authority,
  SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
  'AI tour target must remain source-only unless a real canonical entity exists'
);
assert.equal(aiTarget.can_change_impact, false);
assert(
  aiTarget.sources.some(source => source.availability === 'AVAILABLE'),
  'AI tour target must resolve to materialized source text'
);

const canonicalEntity = model.entities.find(
  entity => entity.authority === SYSTEM_MAP_AUTHORITY.CANONICAL
);
if (canonicalEntity) {
  const canonicalSelection = resolveHumanExplorerSelection(
    model,
    canonicalEntity.selection_id
  );
  assert.equal(canonicalSelection.canonical_node_id, canonicalEntity.canonical_node_id);
  assert.equal(canonicalSelection.can_change_impact, true);
}

const report = {
  schema: 'kneekura.live-love-github-system-map-r2/v1',
  repository: structuredClone(model.repository),
  source_catalog_files: model.stats.source_catalog_files,
  materialized_file_ranges: model.stats.materialized_file_ranges,
  unique_materialized_paths: materializedPaths.size,
  catalog_only_example: catalogOnly.path,
  catalog_only_search_verified: true,
  catalog_only_change_impact_forbidden: true,
  ai_tour_steps: aiTour.steps.length,
  ai_tour_shared_source_resolver_verified: true,
  canonical_entities: model.stats.canonical_entities,
  canonical_change_impact_gate_verified: canonicalEntity != null,
  derived_presentation_entities: model.stats.derived_presentation_entities,
  source_only_entities: model.stats.source_only_entities,
  l0_l3_levels: model.levels.map(item => item.level),
  repository_wide_catalog_search_verified: true
};
await fs.writeFile(
  path.join(OUTPUT_ROOT, 'r2-system-map-report.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf8'
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

async function readJson(fileName) {
  return JSON.parse(
    await fs.readFile(path.join(OUTPUT_ROOT, fileName), 'utf8')
  );
}