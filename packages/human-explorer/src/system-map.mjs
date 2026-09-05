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

  const entities = new Map();
  const sourceViews = buildSourceViews(offlinePayload);
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
    authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
    canonical_node_id: null,
    path: null,
    parent_ids: [],
    child_ids: [],
    source_keys: [],
    human_item_ids: []
  });

  const ensurePackage = pathValue => {
    const packagePath = directoryOf(pathValue);
    if (!packagePath) return null;
    if (packageEntityByPath.has(packagePath)) {
      return packageEntityByPath.get(packagePath);
    }
    const id = `system:package:${encode(packagePath)}`;
    const entity = {
      selection_id: id,
      level: 2,
      kind: 'PACKAGE',
      label: packagePath,
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: packagePath,
      parent_ids: ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: []
    };
    addEntity(entities, entity);
    link(entities, 'system:root', id);
    packageEntityByPath.set(packagePath, id);
    return id;
  };

  const ensureFile = pathValue => {
    const normalizedPath = normalizePath(pathValue);
    if (!normalizedPath) return null;
    if (fileEntityByPath.has(normalizedPath)) {
      return fileEntityByPath.get(normalizedPath);
    }
    const packageId = ensurePackage(normalizedPath);
    const id = `system:file:${encode(normalizedPath)}`;
    const entity = {
      selection_id: id,
      level: 2,
      kind: 'FILE',
      label: fileName(normalizedPath),
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: normalizedPath,
      parent_ids: packageId ? [packageId] : ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: []
    };
    addEntity(entities, entity);
    link(entities, packageId ?? 'system:root', id);
    fileEntityByPath.set(normalizedPath, id);
    return id;
  };

  for (const source of sourceViews.values()) {
    if (source.kind !== 'FILE_RANGE') continue;
    const fileId = ensureFile(source.path);
    const id = `system:source:${encode(source.key)}`;
    addEntity(entities, {
      selection_id: id,
      level: 3,
      kind: 'SOURCE',
      label: source.label,
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: source.path,
      parent_ids: fileId ? [fileId] : ['system:root'],
      child_ids: [],
      source_keys: [source.key],
      human_item_ids: [...(humanItemIdsBySourceKey.get(source.key) ?? [])]
    });
    link(entities, fileId ?? 'system:root', id);
    sourceEntityByKey.set(source.key, id);
  }

  addSourceScopeComponents(
    entities,
    fileEntityByPath,
    sourceViews
  );
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
      source_records: sourceViews.size
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
      authority: SYSTEM_MAP_AUTHORITY.CANONICAL,
      canonical_node_id: canonical.id,
      path: pathValue || null,
      parent_ids: fileId ? [fileId] : ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: []
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
          authority: SYSTEM_MAP_AUTHORITY.DERIVED_PRESENTATION,
          canonical_node_id: null,
          path: null,
          parent_ids: ['system:root'],
          child_ids: [],
          source_keys: [],
          human_item_ids: []
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
      human_item_ids: [...humanItemIds]
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

function addSourceScopeComponents(entities, fileEntityByPath, sourceViews) {
  const roots = new Map();
  for (const source of sourceViews.values()) {
    if (source.kind !== 'FILE_RANGE' || !source.path) continue;
    const root = source.path.split('/')[0] || '(root)';
    if (!roots.has(root)) roots.set(root, new Set());
    roots.get(root).add(source.path);
  }
  for (const [root, paths] of [...roots.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    const id = `system:component:source:${encode(root)}`;
    addEntity(entities, {
      selection_id: id,
      level: 1,
      kind: 'COMPONENT',
      label: `${root}（source scope）`,
      description: 'ソース配置から導出した探索用グループです。canonical componentではありません。',
      authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
      canonical_node_id: null,
      path: root === '(root)' ? null : root,
      parent_ids: ['system:root'],
      child_ids: [],
      source_keys: [],
      human_item_ids: []
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
    description: '同梱ソースから導出した探索用domainです。',
    authority: SYSTEM_MAP_AUTHORITY.DERIVED_SOURCE_ONLY,
    canonical_node_id: null,
    path: null,
    parent_ids: ['system:root'],
    child_ids: [],
    source_keys: [],
    human_item_ids: []
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

function buildSourceViews(payload) {
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
      const text = typeof record.text === 'string' ? record.text : null;
      map.set(key, {
        key,
        kind,
        label: `${pathValue}:${start}${start === end ? '' : `–${end}`}`,
        availability: text == null ? 'UNAVAILABLE' : 'AVAILABLE',
        reason: text == null ? 'SOURCE_TEXT_NOT_MATERIALIZED' : null,
        path: pathValue,
        start_line: start,
        end_line: end,
        rows: text == null
          ? []
          : text.split('\n').map((lineText, index) => ({
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
    human_item_ids: unique(entity.human_item_ids).sort(compareText)
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
      String(ref.content_digest ?? '')
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
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
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