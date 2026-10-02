import { createHash } from 'node:crypto';

export const ANALYZER_FUSION_SCHEMA = 'kneekura.analyzer-fusion/v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function identityFields(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  return {
    kind: candidate.kind ? String(candidate.kind) : null,
    display_name: candidate.display_name ?? candidate.name ?? null,
    language: candidate.language ? String(candidate.language).toUpperCase() : null,
    semantic_symbol_id: candidate.semantic_symbol_id ? String(candidate.semantic_symbol_id) : null,
    semantic_symbol_namespace: candidate.semantic_symbol_namespace ? String(candidate.semantic_symbol_namespace) : null,
    signature: candidate.signature ? String(candidate.signature) : null
  };
}

export function resolveIdentityCandidate(candidate, observation, role = 'subject') {
  const fields = identityFields(candidate);
  if (!fields) return null;
  const { repository_id, snapshot_id } = observation.snapshot ?? {};
  if (!repository_id || !snapshot_id) throw new TypeError('fusion observation is missing repository/snapshot identity');

  if (fields.semantic_symbol_id && fields.semantic_symbol_namespace && fields.language) {
    return {
      exact: true,
      basis: 'SEMANTIC_IDENTITY_EXACT',
      key: stable({
        repository_id,
        snapshot_id,
        language: fields.language,
        semantic_symbol_namespace: fields.semantic_symbol_namespace,
        semantic_symbol_id: fields.semantic_symbol_id
      }),
      fields
    };
  }

  const range = observation.source_range;
  if (role === 'subject' && fields.language && fields.signature && observation.source_file && range?.content_digest && Number.isInteger(range.start_byte) && Number.isInteger(range.end_byte)) {
    return {
      exact: true,
      basis: 'LANGUAGE_SNAPSHOT_SIGNATURE_RANGE_EXACT',
      key: stable({
        repository_id,
        snapshot_id,
        language: fields.language,
        signature: fields.signature,
        path: observation.source_file,
        content_digest: range.content_digest,
        start_byte: range.start_byte,
        end_byte: range.end_byte
      }),
      fields
    };
  }

  return {
    exact: false,
    basis: 'AMBIGUOUS_KEEP_SEPARATE',
    key: stable({ observation_id: observation.id, role }),
    fields
  };
}

function entityFromResolved(resolved) {
  const id = `entity:${sha256(`${resolved.basis}\0${resolved.key}`).slice(0, 32)}`;
  return {
    id,
    identity_basis: resolved.basis,
    exact_identity: resolved.exact,
    kind_candidates: [],
    display_name_candidates: [],
    language_candidates: [],
    observation_refs: []
  };
}

function absorbEntityMetadata(entity, fields) {
  for (const [key, value] of [
    ['kind_candidates', fields.kind],
    ['display_name_candidates', fields.display_name],
    ['language_candidates', fields.language]
  ]) {
    if (value != null && !entity[key].includes(value)) entity[key].push(value);
  }
}

function finalizeEntity(entity) {
  const out = { ...entity };
  for (const key of ['kind_candidates', 'display_name_candidates', 'language_candidates']) out[key] = [...out[key]].sort();
  out.kind = out.kind_candidates.length === 1 ? out.kind_candidates[0] : null;
  out.display_name = out.display_name_candidates.length === 1 ? out.display_name_candidates[0] : null;
  out.language = out.language_candidates.length === 1 ? out.language_candidates[0] : null;
  out.observation_refs = [...out.observation_refs].sort();
  return out;
}

function objectLooksLikeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(value.semantic_symbol_id || value.signature || value.display_name || value.name || value.kind);
}

function buildCorrelations(entities) {
  const groups = new Map();
  for (const entity of entities) {
    if (entity.exact_identity || !entity.display_name) continue;
    const key = stable({
      kind: entity.kind ?? null,
      language: entity.language ?? null,
      display_name: entity.display_name
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entity.id);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({
      id: `correlation:${sha256(key).slice(0, 24)}`,
      reason: 'NAME_ONLY_MATCH_NOT_MERGED',
      entity_refs: [...ids].sort()
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildConflicts(observations, subjectRefByObservation) {
  const groups = new Map();
  for (const observation of observations) {
    const entity_ref = subjectRefByObservation.get(observation.id);
    if (!entity_ref || observation.object === undefined) continue;
    const key = stable({ entity_ref, capability: observation.capability, observation_type: observation.observation_type });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }

  const conflicts = [];
  for (const [key, items] of groups) {
    const alternatives = new Map();
    for (const item of items) {
      const objectKey = stable(item.object);
      if (!alternatives.has(objectKey)) alternatives.set(objectKey, { value: item.object, observation_refs: [] });
      alternatives.get(objectKey).observation_refs.push(item.id);
    }
    if (alternatives.size <= 1) continue;
    conflicts.push({
      id: `conflict:${sha256(key).slice(0, 24)}`,
      resolution: 'PRESERVE_ALL',
      alternatives: [...alternatives.values()]
        .map(entry => ({ ...entry, observation_refs: entry.observation_refs.sort() }))
        .sort((a, b) => stable(a.value).localeCompare(stable(b.value)))
    });
  }
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

export function fuseAnalyzerObservations(inputObservations) {
  if (!Array.isArray(inputObservations)) throw new TypeError('observations must be an array');
  const observations = [...inputObservations].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const entitiesByKey = new Map();
  const endpoint_refs = [];
  const subjectRefByObservation = new Map();

  function bind(candidate, observation, role) {
    const resolved = resolveIdentityCandidate(candidate, observation, role);
    if (!resolved) return null;
    const mapKey = `${resolved.basis}\0${resolved.key}`;
    let entity = entitiesByKey.get(mapKey);
    if (!entity) {
      entity = entityFromResolved(resolved);
      entitiesByKey.set(mapKey, entity);
    }
    absorbEntityMetadata(entity, resolved.fields);
    if (!entity.observation_refs.includes(observation.id)) entity.observation_refs.push(observation.id);
    endpoint_refs.push({ observation_ref: observation.id, role, entity_ref: entity.id, identity_basis: resolved.basis });
    return entity.id;
  }

  for (const observation of observations) {
    if (!observation?.id) throw new TypeError('fusion requires normalized observations with stable ids');
    const subjectRef = bind(observation.subject, observation, 'subject');
    if (subjectRef) subjectRefByObservation.set(observation.id, subjectRef);
    if (objectLooksLikeIdentity(observation.object)) bind(observation.object, observation, 'object');
  }

  const entities = [...entitiesByKey.values()]
    .map(finalizeEntity)
    .sort((a, b) => a.id.localeCompare(b.id));
  endpoint_refs.sort((a, b) => stable(a).localeCompare(stable(b)));

  return {
    schema: ANALYZER_FUSION_SCHEMA,
    observations,
    entities,
    endpoint_refs,
    conflicts: buildConflicts(observations, subjectRefByObservation),
    correlation_groups: buildCorrelations(entities),
    invariants: {
      provider_priority_wins: false,
      last_writer_wins: false,
      name_only_merge: false,
      conflicting_observations_preserved: true
    }
  };
}
