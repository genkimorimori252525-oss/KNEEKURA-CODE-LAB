export const HUMAN_EXPLORER_SYSTEM_MAP_SCHEMA =
  'kneekura.human-explorer-system-map/v1';

export const SYSTEM_MAP_AUTHORITY = Object.freeze({
  CANONICAL: 'CANONICAL',
  DERIVED_PRESENTATION: 'DERIVED_PRESENTATION',
  DERIVED_SOURCE_ONLY: 'DERIVED_SOURCE_ONLY'
});

const OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';
const PRESENTATION_SCHEMA =
  'kneekura.human-analysis-presentation/v1';

export function createHumanExplorerSystemMap({
  projection,
  offlinePayload = null
} = {}) {
  assertProjection(projection);
  if (
    offlinePayload != null &&
    offlinePayload.schema !== OFFLINE_PAYLOAD_SCHEMA
  ) {
    throw new TypeError('System Map offline payload schema is invalid');
  }
  assertOfflinePayloadIdentity(projection, offlinePayload);

  const entities = new Map();
  const sourceCatalog = buildSourceCatalog(offlinePayload);
  const sourceCatalogByPath = new Map(
    sourceCatalog.map(entry => [entry.path, entry])
  );
  const sourceViews = buildSourceViews(
    offlinePayload,
    sourceCatalogByPath
  );
  const sourceEntityByKey = new Map();
  const fileEntityByPath = new Map();
  const packageEntityByPath = new Map();
  const canonicalEntityByNodeId = new Map();
  const humanItemIdsBySourceKey = indexHumanItemsBySource(offlinePayload);

  addEntity(entities, {
    selection_id: 'system:root',
    level: 0,
    kind: 'SYSTEM',
    label: 'System Map',
    description: 'canonical・AI由来・source-onlyを権限ごとに分けて探索します。',
    authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
    canonical_node_id: null,
    path: null,
    parent_ids: [],
    child_ids: [],
    source_keys: [],
    human_item_ids: [],
    catalog_entry: null
  });

  const ensurePackage = pathValue => {
    const packagePath = directoryOf(pathValue);
    if (!packagePath) return null;
    if (packageEntityByPath.has(packagePath)) {
      return packageEntityByPath.get(packagePath);
    }
    const id = `system:package:${encode(packagePath)}`;
    addEntity(entities, {
      selection_id: id,
      level: 2,
      kind: 'PACKAGE',
      label: packagePath,
      description: 'source catalogのpathから導出した探索用packageです。canonical packageではありません。',
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: packagePath,
      parent_ids: ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: [],
      catalog_entry: null
    });
    link(entities, 'system:root', id);
    packageEntityByPath.set(packagePath, id);
    return id;
  };

  const ensureFile = (pathValue, catalogEntry = null) => {
    const normalizedPath = normalizePath(pathValue);
    if (!normalizedPath) return null;
    if (fileEntityByPath.has(normalizedPath)) {
      const existingId = fileEntityByPath.get(normalizedPath);
      const existing = entities.get(existingId);
      if (existing && catalogEntry && !existing.catalog_entry) {
        existing.catalog_entry = structuredClone(catalogEntry);
        existing.description = 'source catalogに記録されたファイルです。本文が未同梱でも検索対象に残ります。';
      }
      return existingId;
    }
    const packageId = ensurePackage(normalizedPath);
    const id = `system:file:${encode(normalizedPath)}`;
    addEntity(entities, {
      selection_id: id,
      level: 2,
      kind: 'FILE',
      label: fileName(normalizedPath),
      description: catalogEntry
        ? 'source catalogに記録されたファイルです。本文が未同梱でも検索対象に残ります。'
        : '同梱source rangeから導出した探索用fileです。',
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: normalizedPath,
      parent_ids: packageId ? [packageId] : ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: [],
      catalog_entry: catalogEntry ? structuredClone(catalogEntry) : null
    });
    addEntity(entities, entityForFile(id, normalizedPath, packageId, catalogEntry));
    link(entities, packageId ?? 'system:root', id);
    fileEntityByPath.set(normalizedPath, id);
    return id;
  };

  for (const entry of sourceCatalog) {
    ensureFile(entry.path, entry);
  }

  for (const source of sourceViews.values()) {
    if (source.kind !== 'FILE_RANGE') continue;
    const fileId = ensureFile(
      source.path,
      sourceCatalogByPath.get(source.path) ?? null
    );
    const id = `system:source:${encode(source.key)}`;
    addEntity(entities, {
      selection_id: id,
      level: 3,
      kind: 'SOURCE',
      label: source.label,
      description: source.availability === 'AVAILABLE'
        ? 'snapshot-boundの同梱source rangeです。'
        : 'source refはありますが本文は同梱されていません。',
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: source.path,
      parent_ids: fileId ? [fileId] : ['system:root'],
      child_ids: [],
      source_keys: [source.key],
      human_item_ids: [...(humanItemIdsBySourceKey.get(source.key) ?? [])],
      catalog_entry: null
    });
    link(entities, fileId ?? 'system:root', id);
    sourceEntityByKey.set(source.key, id);

    const fileEntity = fileId ? entities.get(fileId) : null;
    if (fileEntity) {
      if (!fileEntity.source_keys.includes(source.key)) {
        fileEntity.source_keys.push(source.key);
      }
      for (const itemId of humanItemIdsBySourceKey.get(source.key) ?? []) {
        if (!fileEntity.human_item_ids.includes(itemId)) {
          fileEntity.human_item_ids.push(itemId);
        }
      }
    }
  }

  addSourceScopeComponents(entities, fileEntityByPath);
  addSourceDomain(entities, fileEntityByPath);
  addCanonicalEntities({
    projection,
    entities,
    canonicalEntityByNodeId,
    ensureFile
  });
  addPresentationComponents({
    offlinePayload,
    entities,
    sourceEntityByKey,
    fileEntityByPath,
    humanItemIdsBySourceKey
  });

  const entityList = [...entities.values()]
    .map(normalizeEntity)
    .sort(compareEntity);
  const entityById = new Map(
    entityList.map(entity => [entity.selection_id, entity])
  );
  const searchIndex = entityList.map(entity => ({
    selection_id: entity.selection_id,
    level: entity.level,
    kind: entity.kind,
    label: entity.label,
    authority: entity.authority,
    path: entity.path,
    search_text: normalizeSearch([
      entity.label,
      entity.description,
      entity.kind,
      entity.path,
      entity.authority,
      ...entity.human_item_ids
    ].filter(Boolean).join(' '))
  }));
  const tours = buildTours({
    projection,
    offlinePayload,
    canonicalEntityByNodeId,
    sourceEntityByKey
  });

  const model = {
    schema: HUMAN_EXPLORER_SYSTEM_MAP_SCHEMA,
    repository: resolveRepositoryIdentity(projection, offlinePayload),
    levels: [
      { level: 0, label: 'System' },
      { level: 1, label: 'Component / Domain' },
      { level: 2, label: 'Package / File' },
      { level: 3, label: 'Symbol / Source' }
    ],
    entities: entityList,
    search_index: searchIndex,
    tours,
    stats: {
      canonical_entities: entityList.filter(
        entity => entity.authority === SYSTEM_MAP_AUTHORITY.CANONICAL
      ).length,
      derived_presentation_entities: entityList.filter(
        entity => entity.authority === SYSTEM_MAP_AUTHORITY.DERIVED_PRESENTATION
      ).length,
      source_only_entities: entityList.filter(
        entity => entity.authority === SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY
      ).length,
      source_records: sourceViews.size,
      source_catalog_files: sourceCatalog.length,
      materialized_file_ranges: [...sourceViews.values()].filter(
        source => source.kind === 'FILE_RANGE' && source.availability === 'AVAILABLE'
      ).length
    },
    _runtime: {
      entity_by_id: entityById,
      source_by_key: sourceViews
    }
  };
  return deepFreeze(model);
}

export function searchHumanExplorerSystemMap(
  model,
  query,
  { limit = 100 } = {}
) {
  assertSystemMap(model);
  const needle = normalizeSearch(query);
  if (!needle) return [];
  const boundedLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(limit, 500))
    : 100;
  return model.search_index
    .filter(entry => entry.search_text.includes(needle))
    .sort((a, b) =>
      searchRank(a, needle) - searchRank(b, needle) ||
      compareText(a.label, b.label) ||
      compareText(a.selection_id, b.selection_id)
    )
    .slice(0, boundedLimit)
    .map(entry => ({
      selection_id: entry.selection_id,
      level: entry.level,
      kind: entry.kind,
      label: entry.label,
      authority: entry.authority,
      path: entry.path
    }));
}

export function resolveHumanExplorerSelection(
  model,
  selectionId,
  sourceKey = null
) {
  assertSystemMap(model);
  const entity = model._runtime.entity_by_id.get(String(selectionId));
  if (!entity) return null;
  const sources = entity.source_keys
    .map(key => model._runtime.source_by_key.get(key))
    .filter(Boolean);
  const requested = sourceKey == null
    ? sources[0] ?? null
    : sources.find(source => source.key === String(sourceKey)) ?? null;
  return deepFreeze({
    selection_id: entity.selection_id,
    entity: structuredClone(entity),
    authority: entity.authority,
    canonical_node_id: entity.canonical_node_id,
    can_change_impact:
      entity.authority === SYSTEM_MAP_AUTHORITY.CANONICAL &&
      typeof entity.canonical_node_id === 'string' &&
      entity.canonical_node_id.length > 0,
    sources: structuredClone(sources),
    selected_source: requested ? structuredClone(requested) : null,
    human_item_ids: [...entity.human_item_ids]
  });
}

function entityForFile(id, normalizedPath, packageId, catalogEntry) {
  return {
    selection_id: id,
    level: 2,
    kind: 'FILE',
    label: fileName(normalizedPath),
    description: catalogEntry
      ? 'source catalogに記録されたファイルです。本文が未同梱でも検索対象に残ります。'
      : '同梱source rangeから導出した探索用fileです。',
    authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
    canonical_node_id: null,
    path: normalizedPath,
    parent_ids: packageId ? [packageId] : ['system:root'],
    child_ids: [],
    source_keys: [],
    human_item_ids: [],
    catalog_entry: catalogEntry ? structuredClone(catalogEntry) : null
  };
}

function addCanonicalEntities({
  projection,
  entities,
  canonicalEntityByNodeId,
  ensureFile
}) {
  const canonicalNodes = projection.canonical.graph.nodes;
  for (const meta of projection.presentation.nodes) {
    const canonical = canonicalNodes[meta.canonical_index];
    if (!canonical || canonical.id !== meta.node_id) {
      throw new TypeError(
        `System Map canonical node trace mismatch: ${String(meta.node_id)}`
      );
    }
    const pathValue = normalizePath(canonical.path ?? meta.path ?? '');
    const fileId = pathValue ? ensureFile(pathValue) : null;
    const id = `system:canonical:${encode(canonical.id)}`;
    addEntity(entities, {
      selection_id: id,
      level: 3,
      kind: 'SYMBOL',
      label: String(meta.label ?? canonical.label ?? canonical.id),
      description: 'Explorer Projectionが保持する実canonical nodeです。',
      authority: SYSTEM_MAP_AUTHORITY.CANONICAL,
      canonical_node_id: canonical.id,
      path: pathValue || null,
      parent_ids: fileId ? [fileId] : ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: [],
      catalog_entry: null
    });
    link(entities, fileId ?? 'system:root', id);
    canonicalEntityByNodeId.set(canonical.id, id);

    const family = String(meta.display_family ?? '').trim();
    if (family) {
      const domainId = `system:domain:canonical:${encode(family)}`;
      if (!entities.has(domainId)) {
        addEntity(entities, {
          selection_id: domainId,
          level: 1,
          kind: 'DOMAIN',
          label: family,
          description: 'canonical nodeのdisplay familyから導出したpresentation domainです。',
          authority: SYSTEM_MAP_AUTHORITY.DERIVED_PRESENTATION,
          canonical_node_id: null,
          path: null,
          parent_ids: ['system:root'],
          child_ids: [],
          source_keys: [],
          human_item_ids: [],
          catalog_entry: null
        });
        link(entities, 'system:root', domainId);
      }
      link(entities, domainId, id);
    }
  }
}

function addPresentationComponents({
  offlinePayload,
  entities,
  sourceEntityByKey,
  fileEntityByPath,
  humanItemIdsBySourceKey
}) {
  const presentation = offlinePayload?.presentation;
  if (!presentation) return;
  if (presentation.schema !== PRESENTATION_SCHEMA) {
    throw new TypeError('System Map presentation schema is invalid');
  }
  for (const component of presentation.components ?? []) {
    const id = `system:component:${encode(
      component.component_id ?? component.item_id ?? component.name
    )}`;
    const sourceKeys = (component.member_refs ?? []).map(sourceKey);
    const humanItemIds = new Set([component.item_id].filter(Boolean));
    for (const key of sourceKeys) {
      for (const itemId of humanItemIdsBySourceKey.get(key) ?? []) {
        humanItemIds.add(itemId);
      }
    }
    addEntity(entities, {
      selection_id: id,
      level: 1,
      kind: 'COMPONENT',
      label: String(component.name ?? component.item_id ?? 'Component'),
      description: String(component.responsibility ?? ''),
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_PRESENTATION,
      canonical_node_id: null,
      path: null,
      parent_ids: ['system:root'],
      child_ids: [],
      source_keys: sourceKeys,
      human_item_ids: [...humanItemIds],
      catalog_entry: null
    });
    link(entities, 'system:root', id);
    for (const ref of component.member_refs ?? []) {
      const key = sourceKey(ref);
      const sourceId = sourceEntityByKey.get(key);
      if (sourceId) link(entities, id, sourceId);
      if (String(ref.kind).toUpperCase() === 'FILE_RANGE') {
        const fileId = fileEntityByPath.get(normalizePath(ref.path));
        if (fileId) link(entities, id, fileId);
      }
    }
  }
}

function addSourceScopeComponents(entities, fileEntityByPath) {
  const roots = new Map();
  for (const pathValue of fileEntityByPath.keys()) {
    const root = pathValue.split('/')[0] || '(root)';
    if (!roots.has(root)) roots.set(root, new Set());
    roots.get(root).add(pathValue);
  }
  for (const [root, paths] of [...roots.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    const id = `system:component:source:${encode(root)}`;
    addEntity(entities, {
      selection_id: id,
      level: 1,
      kind: 'COMPONENT',
      label: `${root}（source scope）`,
      description: 'source catalogの配置から導出した探索用グループです。canonical componentではありません。',
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: root === '(root)' ? null : root,
      parent_ids: ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: [],
      catalog_entry: null
    });
    link(entities, 'system:root', id);
    for (const pathValue of paths) {
      const fileId = fileEntityByPath.get(pathValue);
      if (fileId) link(entities, id, fileId);
    }
  }
}

function addSourceDomain(entities, fileEntityByPath) {
  if (fileEntityByPath.size === 0) return;
  const id = 'system:domain:source';
  addEntity(entities, {
    selection_id: id,
    level: 1,
    kind: 'DOMAIN',
    label: 'Source',
    description: 'source catalogから導出した探索用domainです。',
    authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
    canonical_node_id: null,
    path: null,
    parent_ids: ['system:root'],
    child_ids: [],
    source_keys: [],
    human_item_ids: [],
    catalog_entry: null
  });
  link(entities, 'system:root', id);
  for (const fileId of fileEntityByPath.values()) link(entities, id, fileId);
}

function buildTours({
  projection,
  offlinePayload,
  canonicalEntityByNodeId,
  sourceEntityByKey
}) {
  const tours = [];
  const canonicalSteps = projection.canonical.graph.nodes
    .filter(node => node.kind === 'ua:tour_step')
    .map(node => {
      const targets = projection.canonical.graph.edges
        .filter(edge =>
          edge.from === node.id && edge.type === 'UA_TOUR_HIGHLIGHTS'
        )
        .map(edge => canonicalEntityByNodeId.get(edge.to))
        .filter(Boolean);
      const own = canonicalEntityByNodeId.get(node.id);
      return {
        step_id: `canonical:${node.id}`,
        order: Number.isFinite(node.order) ? node.order : null,
        label: String(node.label ?? node.id),
        body: String(node.description ?? ''),
        target_selection_ids: targets.length ? targets : own ? [own] : []
      };
    })
    .sort(compareTourStep);
  if (canonicalSteps.length) {
    tours.push({
      tour_id: 'system:tour:canonical',
      kind: 'CANONICAL',
      label: 'canonicalガイドツアー',
      steps: canonicalSteps
    });
  }

  const irItems = new Map(
    (offlinePayload?.experience?.derived?.human_analysis_ir?.items ?? [])
      .filter(item => item.review_status === 'ACCEPT')
      .map(item => [item.id, item])
  );
  const presentationTour = offlinePayload?.presentation?.tour ?? [];
  const aiSpecs = presentationTour.length
    ? presentationTour.map(entry => ({
        item: irItems.get(entry.item_id),
        order: entry.order,
        refs: entry.target_refs ?? []
      }))
    : [...irItems.values()]
        .filter(item => item.kind === 'TOUR_STEP')
        .map((item, index) => ({
          item,
          order: index,
          refs: item.source_refs ?? []
        }));
  const aiSteps = aiSpecs
    .filter(spec => spec.item)
    .map(spec => ({
      step_id: `ai:${spec.item.id}`,
      order: Number.isFinite(spec.order) ? spec.order : null,
      label: String(spec.item.title ?? spec.item.id),
      body: String(spec.item.body ?? ''),
      target_selection_ids: unique(
        spec.refs.map(ref => sourceEntityByKey.get(sourceKey(ref))).filter(Boolean)
      )
    }))
    .sort(compareTourStep);
  if (aiSteps.length) {
    tours.push({
      tour_id: 'system:tour:ai',
      kind: 'AI_AUTHORED',
      label: 'AIによるガイドツアー',
      steps: aiSteps
    });
  }
  return tours;
}

function buildSourceCatalog(payload) {
  const rows = payload?.experience?.source_index?.files ?? [];
  if (!Array.isArray(rows)) {
    throw new TypeError('System Map source catalog must be an array');
  }
  const seen = new Set();
  return rows.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`System Map source catalog entry is invalid: ${index}`);
    }
    const pathValue = normalizePath(entry.path);
    if (!pathValue) {
      throw new TypeError(`System Map source catalog path is empty: ${index}`);
    }
    if (seen.has(pathValue)) {
      throw new TypeError(`System Map duplicate source catalog path: ${pathValue}`);
    }
    seen.add(pathValue);
    const digest = String(entry.content_digest ?? '');
    if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
      throw new TypeError(`System Map source catalog digest is invalid: ${pathValue}`);
    }
    const lineCount = entry.line_count == null ? null : Number(entry.line_count);
    if (lineCount != null && (!Number.isInteger(lineCount) || lineCount < 1)) {
      throw new TypeError(`System Map source catalog line count is invalid: ${pathValue}`);
    }
    return {
      path: pathValue,
      content_digest: digest.toLowerCase(),
      ...(lineCount == null ? {} : { line_count: lineCount })
    };
  }).sort((a, b) => compareText(a.path, b.path));
}

function buildSourceViews(payload, sourceCatalogByPath) {
  const map = new Map();
  for (const record of payload?.sources?.records ?? []) {
    const ref = record?.ref;
    const key = sourceKey(ref);
    if (map.has(key)) {
      throw new TypeError(`System Map duplicate source record: ${key}`);
    }
    const kind = String(ref?.kind ?? '').toUpperCase();
    if (kind === 'FILE_RANGE') {
      const pathValue = normalizePath(ref.path);
      const start = Number(ref.start_line);
      const end = Number(ref.end_line);
      if (
        !pathValue ||
        !Number.isInteger(start) ||
        start < 1 ||
        !Number.isInteger(end) ||
        end < start
      ) {
        throw new TypeError(`System Map FILE_RANGE is invalid: ${key}`);
      }
      const digest = String(ref.content_digest ?? '').toLowerCase();
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new TypeError(`System Map FILE_RANGE digest is invalid: ${pathValue}`);
      }
      const catalog = sourceCatalogByPath.get(pathValue) ?? null;
      if (catalog && catalog.content_digest !== digest) {
        throw new TypeError(`System Map FILE_RANGE catalog digest mismatch: ${pathValue}`);
      }
      if (
        catalog?.line_count != null &&
        end > catalog.line_count
      ) {
        throw new TypeError(`System Map FILE_RANGE exceeds source catalog: ${pathValue}`);
      }
      if (
        record.content_digest != null &&
        String(record.content_digest).toLowerCase() !== digest
      ) {
        throw new TypeError(`System Map FILE_RANGE record digest mismatch: ${pathValue}`);
      }
      const text = typeof record.text === 'string' ? record.text : null;
      const rows = text == null ? [] : text.split('\n');
      if (text != null && rows.length !== end - start + 1) {
        throw new TypeError(`System Map FILE_RANGE line count mismatch: ${pathValue}:${start}-${end}`);
      }
      map.set(key, {
        key,
        kind,
        label: `${pathValue}:${start}${start === end ? '' : `–${end}`}`,
        availability: text == null ? 'UNAVAILABLE' : 'AVAILABLE',
        reason: text == null ? 'SOURCE_TEXT_NOT_MATERIALIZED' : null,
        path: pathValue,
        start_line: start,
        end_line: end,
        rows: rows.map((lineText, index) => ({
          line: start + index,
          text: lineText
        })),
        technical_ref: structuredClone(ref)
      });
      continue;
    }
    map.set(key, {
      key,
      kind,
      label: kind || 'canonical record',
      availability: record?.record ? 'CANONICAL_RECORD' : 'UNAVAILABLE',
      reason: record?.record ? null : 'CANONICAL_RECORD_NOT_MATERIALIZED',
      path: null,
      rows: [],
      technical_ref: structuredClone(ref),
      technical_record: record?.record ? structuredClone(record.record) : null
    });
  }
  return map;
}

function indexHumanItemsBySource(payload) {
  const map = new Map();
  for (const item of payload?.experience?.derived?.human_analysis_ir?.items ?? []) {
    if (item.review_status !== 'ACCEPT') continue;
    for (const ref of item.source_refs ?? []) {
      const key = sourceKey(ref);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(item.id);
    }
  }
  return map;
}

function assertOfflinePayloadIdentity(projection, payload) {
  if (payload == null) return;
  const projectionRepository = projection.source?.repository_id;
  const projectionSnapshot = projection.source?.snapshot_id;
  const experienceRepository = payload.experience?.repository?.repository_id;
  const experienceSnapshot = payload.experience?.repository?.snapshot_id;
  for (const [label, value] of [
    ['Explorer repository', projectionRepository],
    ['Explorer snapshot', projectionSnapshot],
    ['Human Experience repository', experienceRepository],
    ['Human Experience snapshot', experienceSnapshot]
  ]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`System Map identity is missing: ${label}`);
    }
  }
  if (
    projectionRepository !== experienceRepository ||
    projectionSnapshot !== experienceSnapshot
  ) {
    throw new TypeError('System Map Explorer/Human Experience identity mismatch');
  }
  const sourceRepository = payload.sources?.repository;
  if (sourceRepository) {
    if (
      sourceRepository.repository_id !== experienceRepository ||
      sourceRepository.snapshot_id !== experienceSnapshot
    ) {
      throw new TypeError('System Map source bundle identity mismatch');
    }
  }
  const embeddedProjection =
    payload.experience?.canonical?.explorer_projection;
  if (embeddedProjection) {
    if (
      embeddedProjection.source?.repository_id !== projectionRepository ||
      embeddedProjection.source?.snapshot_id !== projectionSnapshot
    ) {
      throw new TypeError('System Map embedded Explorer identity mismatch');
    }
  }
}

function addEntity(entities, entity) {
  if (entities.has(entity.selection_id)) {
    throw new TypeError(`System Map duplicate entity: ${entity.selection_id}`);
  }
  entities.set(entity.selection_id, entity);
}

function link(entities, parentId, childId) {
  if (!parentId || !childId || parentId === childId) return;
  const parent = entities.get(parentId);
  const child = entities.get(childId);
  if (!parent || !child) return;
  if (!parent.child_ids.includes(childId)) parent.child_ids.push(childId);
  if (!child.parent_ids.includes(parentId)) child.parent_ids.push(parentId);
}

function normalizeEntity(entity) {
  return {
    ...entity,
    description: String(entity.description ?? ''),
    parent_ids: unique(entity.parent_ids).sort(compareText),
    child_ids: unique(entity.child_ids).sort(compareText),
    source_keys: unique(entity.source_keys).sort(compareText),
    human_item_ids: unique(entity.human_item_ids).sort(compareText),
    catalog_entry: entity.catalog_entry
      ? structuredClone(entity.catalog_entry)
      : null
  };
}

function assertProjection(projection) {
  if (
    !projection ||
    projection.schema !== 'kneekura.explorer-projection/v1' ||
    !Array.isArray(projection.canonical?.graph?.nodes) ||
    !Array.isArray(projection.canonical?.graph?.edges) ||
    !Array.isArray(projection.presentation?.nodes) ||
    !Array.isArray(projection.presentation?.edges)
  ) {
    throw new TypeError('System Map requires Explorer Projection v1');
  }
}

function assertSystemMap(model) {
  if (
    !model ||
    model.schema !== HUMAN_EXPLORER_SYSTEM_MAP_SCHEMA ||
    !Array.isArray(model.entities) ||
    !model._runtime?.entity_by_id ||
    !model._runtime?.source_by_key
  ) {
    throw new TypeError('Invalid Human Explorer System Map');
  }
}

function resolveRepositoryIdentity(projection, payload) {
  return structuredClone(
    payload?.experience?.repository ?? projection.source ?? null
  );
}

function sourceKey(ref) {
  const kind = String(ref?.kind ?? '').toUpperCase();
  if (kind === 'FILE_RANGE') {
    return [
      'FILE_RANGE',
      normalizePath(ref.path),
      Number(ref.start_line),
      Number(ref.end_line),
      String(ref.content_digest ?? '').toLowerCase()
    ].join(':');
  }
  return `${kind}:${String(ref?.id ?? '')}`;
}

function directoryOf(pathValue) {
  const normalized = normalizePath(pathValue);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function fileName(pathValue) {
  const normalized = normalizePath(pathValue);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function normalizePath(value) {
  const normalized = String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
  if (!normalized) return '';
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new TypeError(`System Map unsafe repository path: ${String(value)}`);
  }
  return normalized;
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function normalizeSearch(value) {
  return String(value ?? '').trim().toLowerCase();
}

function searchRank(entry, needle) {
  const label = normalizeSearch(entry.label);
  const pathValue = normalizeSearch(entry.path);
  if (label === needle) return 0;
  if (pathValue === needle) return 1;
  if (label.startsWith(needle)) return 2;
  if (pathValue.startsWith(needle)) return 3;
  return 4;
}

function compareEntity(a, b) {
  return a.level - b.level ||
    compareText(a.kind, b.kind) ||
    compareText(a.label, b.label) ||
    compareText(a.selection_id, b.selection_id);
}

function compareTourStep(a, b) {
  const left = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
  const right = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
  return left - right || compareText(a.step_id, b.step_id);
}

function unique(values) {
  return [...new Set(values)];
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (value instanceof Map) {
    for (const [key, child] of value) {
      deepFreeze(key);
      deepFreeze(child);
    }
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}