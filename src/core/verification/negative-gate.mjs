export function evaluateNegativeGate({
  searchedProperty,
  providerId = null,
  graph,
  coverage,
  searchUniverse,
  irrelevantItemIds = [],
  evidenceRecords = [],
  counterevidenceLinks = [],
  currentSnapshotIds = [],
  staleEvidenceIds = [],
  stale = false
}) {
  const property = String(searchedProperty ?? '').trim();
  if (!property) return denied('SEARCHED_PROPERTY_UNSPECIFIED', 'searched property is required');

  const providers = (graph?.meta?.providers ?? []).filter(provider =>
    (!providerId || provider.id === providerId) &&
    provider.capabilities?.supported_properties?.includes(property)
  );
  if (!providers.length) {
    return denied(
      'ANALYZER_UNSUPPORTED',
      'no active provider declares support for searched property ' + property
    );
  }

  const activeProviderIds = new Set(providers.map(provider => provider.id));
  const failures = (graph?.meta?.providerFailures ?? []).filter(failure =>
    activeProviderIds.has(failure.provider_id)
  );
  if (failures.length) {
    return denied(
      'ANALYZER_FAILED',
      'a relevant provider failed while evaluating the searched property',
      { failure_codes: [...new Set(failures.map(failure => failure.code))].sort() }
    );
  }

  if (!searchUniverse || typeof searchUniverse !== 'object') {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'negative verification requires an explicit search universe');
  }
  if (typeof searchUniverse.id !== 'string' || !searchUniverse.id.trim()) {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'search universe must have a stable id');
  }
  if (searchUniverse.enumerable !== true) {
    return denied('SEARCH_UNIVERSE_NOT_ENUMERABLE', 'search universe must be enumerable');
  }
  if (!Array.isArray(searchUniverse.item_ids)) {
    return denied('SEARCH_UNIVERSE_NOT_EXPLICIT', 'search universe item_ids are required');
  }

  if (!coverage || !Array.isArray(coverage.entries)) {
    return denied('COVERAGE_MISSING', 'negative verification requires Coverage Manifest entries');
  }

  const irrelevant = new Set(irrelevantItemIds);
  const coverageById = new Map(coverage.entries.map(entry => [entry.id, entry]));
  for (const id of searchUniverse.item_ids) {
    const entry = coverageById.get(id);
    if (!entry) {
      return denied(
        'COVERAGE_MISSING_ITEM',
        'search-universe item is not represented in Coverage Manifest',
        { item_id: id }
      );
    }

    if (entry.status === 'FAILED') {
      return denied(
        'ANALYZER_FAILED',
        'relevant coverage item failed analysis',
        { item_id: id, reason: entry.reason ?? null }
      );
    }

    if (['UNEXPLORED','PENDING'].includes(entry.status)) {
      return denied(
        'COVERAGE_GAP',
        'relevant coverage item remains unexplored',
        { item_id: id, status: entry.status, reason: entry.reason ?? null }
      );
    }

    if (entry.status === 'SKIPPED' && !irrelevant.has(id) && entry.proven_irrelevant !== true) {
      return denied(
        'SKIPPED_NOT_PROVEN_IRRELEVANT',
        'skipped search-universe item was not deterministically proven irrelevant',
        { item_id: id }
      );
    }

    if (!['ANALYZED','REUSED','SKIPPED'].includes(entry.status)) {
      return denied(
        'COVERAGE_NOT_TERMINAL',
        'relevant coverage item is not terminally accounted',
        { item_id: id, status: entry.status }
      );
    }
  }

  if (stale) return denied('STALE_SNAPSHOT', 'negative verification context is stale');

  const staleIds = new Set(staleEvidenceIds);
  if (evidenceRecords.some(record => staleIds.has(record.id))) {
    return denied('STALE_EVIDENCE', 'negative verification depends on stale evidence');
  }

  const current = new Set(currentSnapshotIds);
  if (current.size) {
    if (coverage.snapshot_id && !current.has(coverage.snapshot_id)) {
      return denied('STALE_SNAPSHOT', 'Coverage Manifest belongs to a different snapshot');
    }
    for (const record of evidenceRecords) {
      if (!current.has(record.provenance?.snapshot_id)) {
        return denied(
          'STALE_SNAPSHOT',
          'negative verification evidence belongs to a different snapshot',
          { evidence_id: record.id }
        );
      }
    }
  }

  if (counterevidenceLinks.length) {
    return denied(
      'COUNTEREVIDENCE_PRESENT',
      'counterevidence prevents a strong negative claim',
      { evidence_ids: counterevidenceLinks.map(link => link.evidence_id).sort() }
    );
  }

  const graphSearch = searchGraphForPositiveProperty(graph, property, activeProviderIds);
  if (!graphSearch.supported) {
    return denied(
      'COUNTEREVIDENCE_SEARCH_UNAVAILABLE',
      'CORE has no deterministic positive-property detector for this negative claim',
      { searched_property: property, provider_ids: [...activeProviderIds].sort() }
    );
  }
  if (graphSearch.refs.length) {
    return denied(
      'COUNTEREVIDENCE_FOUND',
      'positive evidence for the searched property exists in the analyzed graph',
      { refs: graphSearch.refs }
    );
  }

  return {
    allowed: true,
    outcome: 'VERIFIED',
    reason_code: 'NEGATIVE_GATE_PASSED',
    message: 'explicit enumerable universe is fully accounted with supported current-snapshot analysis and no counterevidence',
    provider_ids: [...activeProviderIds].sort(),
    search_universe_id: searchUniverse.id
  };
}

function searchGraphForPositiveProperty(graph, property, activeProviderIds) {
  const providerIds = new Set(activeProviderIds);
  const nodeKinds = new Set();
  const nodeKindPrefixes = new Set();
  const javaClassTypes = new Set();
  const edgeTypes = new Set();

  const add = ({ nodes = [], nodePrefixes = [], classTypes = [], edges = [] }) => {
    for (const kind of nodes) nodeKinds.add(kind);
    for (const prefix of nodePrefixes) nodeKindPrefixes.add(prefix);
    for (const classType of classTypes) javaClassTypes.add(classType);
    for (const type of edges) edgeTypes.add(type);
  };

  if (providerIds.has('network-companion-adapter')) {
    const map = {
      'packet-send': { edges: ['OBSERVED_PACKET_SEND'] },
      'packet-receive': { edges: ['OBSERVED_PACKET_RECEIVE'] },
      'runtime-molang-payload': { edges: ['OBSERVED_PACKET_PAYLOAD_MOLANG'] },
      'network-semantic': {
        nodes: ['runtime_network_semantic_observation'],
        edges: [
          'OBSERVED_MOLANG_HANDLER_EXECUTION',
          'OBSERVED_YSM_MOLANG_COMMAND_PRE_DISPATCH',
          'OBSERVED_YSM_MOLANG_COMMAND_DISPATCH',
          'OBSERVED_YSM_MOLANG_COMMAND_FAILURE',
          'OBSERVED_YSM_CLIENT_COMMAND_HANDLED',
          'OBSERVED_YSM_CLIENT_COMMAND_FALLBACK',
          'OBSERVED_YSM_MOLANG_STATE_APPLIED',
          'OBSERVED_YSM_STATE_CORRELATED'
        ]
      }
    };
    if (map[property]) add(map[property]);
  }

  if (providerIds.has('runtime-trace-adapter')) {
    const map = {
      'runtime-entity': { nodes: ['runtime_entity'] },
      'runtime-animation': {
        edges: ['OBSERVED_RUNTIME_ANIMATION','OBSERVED_RUNTIME_PENDING_ANIMATION']
      },
      'runtime-molang': {
        edges: ['OBSERVED_RUNTIME_MOLANG_SEND','OBSERVED_RUNTIME_FACE_STATE']
      }
    };
    if (map[property]) add(map[property]);
  }

  if (providerIds.has('pose-companion-adapter') && property === 'runtime-pose') {
    add({ nodes: ['runtime_pose_capture'] });
  }
  if (providerIds.has('palette-companion-adapter') && property === 'runtime-bone-palette') {
    add({ nodes: ['runtime_palette_capture','runtime_bone_series'] });
  }

  if (providerIds.has('forge-1.20.1-network')) {
    const map = {
      'packet-registration': { edges: ['REGISTERS_PACKET'] },
      'packet-send': { edges: ['SENDS_PACKET','DECLARES_NETWORK_SEND'] },
      'packet-handler': { edges: ['HANDLED_BY','DISPATCHES_NETWORK_HANDLER'] },
      'network-channel': { nodes: ['network_channel'] }
    };
    if (map[property]) add(map[property]);
  }

  if (providerIds.has('builtin-java')) {
    const map = {
      package: { nodes: ['package'] },
      import: { edges: ['IMPORTS'] },
      class: { classTypes: ['class'] },
      interface: { classTypes: ['interface'] },
      enum: { classTypes: ['enum'] },
      record: { classTypes: ['record'] },
      method: { nodes: ['method'] }
    };
    if (map[property]) add(map[property]);
  }

  if (providerIds.has('forge-semantics')) {
    const map = {
      'forge-registration': { edges: ['ACCESSES_REGISTRY','CREATES_DEFERRED_REGISTER'] },
      'forge-event': { edges: ['SUBSCRIBES_EVENT'] },
      'forge-mixin': { edges: ['MIXES_INTO','INJECTS_AT'] }
    };
    if (map[property]) add(map[property]);
  }

  if (
    providerIds.has('minecraft-ysm-semantics') ||
    providerIds.has('minecraft-ysm-json')
  ) {
    const map = {
      molang: { nodes: ['molang_variable'], edges: ['READS_MOLANG','WRITES_MOLANG'] },
      animation: {
        nodes: ['animation_name','animation_definition','animation_controller'],
        edges: ['DECLARES_ANIMATION','PROVIDES_ANIMATION_NAME']
      },
      bone: {
        nodes: ['bone_name','model_bone','model_bone_reference'],
        edges: ['HAS_BONE','ANIMATES_BONE','PROVIDES_BONE_NAME']
      },
      resource: {
        nodes: ['resource_directory','model_definition','ysm_model_pack'],
        edges: ['REFERENCES_RESOURCE']
      },
      'ysm-bridge': {
        edges: [
          'BOUNDARY_PRODUCES_MOLANG',
          'BOUNDARY_CONSUMES_MOLANG',
          'BOUNDARY_DISPATCHES_ANIMATION',
          'BOUNDARY_PROVIDES_ANIMATION'
        ]
      }
    };
    if (map[property]) add(map[property]);
  }

  if (providerIds.has('forge-mods-toml') && property === 'forge-mod-metadata') {
    add({ nodes: ['mod'], edges: ['DECLARES_MOD'] });
  }
  if (providerIds.has('codegraph-adapter') && property === 'external-codegraph') {
    add({ nodePrefixes: ['codegraph:'] });
  }
  if (providerIds.has('understand-anything-adapter') && property === 'external-understanding') {
    add({ nodePrefixes: ['ua:'] });
  }

  if (!nodeKinds.size && !nodeKindPrefixes.size && !javaClassTypes.size && !edgeTypes.size) {
    return { supported: false, refs: [] };
  }

  const refs = [];
  for (const node of graph?.nodes ?? []) {
    const kind = String(node.kind ?? '');
    const prefixMatch = [...nodeKindPrefixes].some(prefix => kind.startsWith(prefix));
    const classTypeMatch =
      kind === 'class' &&
      javaClassTypes.has(String(node.classType ?? 'class'));
    if (nodeKinds.has(kind) || prefixMatch || classTypeMatch) {
      refs.push('node:' + node.id);
    }
  }
  for (const edge of graph?.edges ?? []) {
    if (edgeTypes.has(edge.type)) refs.push('edge:' + edge.id);
  }

  return {
    supported: true,
    refs: [...new Set(refs)].sort()
  };
}

function denied(reasonCode, message, details = null) {
  return {
    allowed: false,
    outcome: 'UNKNOWN',
    reason_code: reasonCode,
    message,
    ...(details ? { details: structuredClone(details) } : {})
  };
}
