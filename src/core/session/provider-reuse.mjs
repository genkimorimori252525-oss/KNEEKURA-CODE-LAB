import {
  acquireAndRecord,
  recordProviderResult
} from '../evidence/provider.mjs';
import {
  findReusableAcquisition,
  recordProviderAcquisition
} from './exploration-ledger.mjs';

export async function acquireWithExploration(
  provider,
  context,
  unit = {},
  {
    explorationLedger,
    requiredFidelity = 0,
    onEvent = null
  } = {}
) {
  if (!explorationLedger) {
    return acquireAndRecord(provider, context, unit);
  }

  const dependencyFingerprint = await provider.dependencyFingerprint(context, unit);
  const providerVersion = provider.version;
  const providerId = provider.id;

  const reusable = findReusableAcquisition(explorationLedger, {
    providerId,
    providerVersion,
    dependencyFingerprint,
    requiredFidelity,
    targetSnapshotId: context.snapshot.snapshot_id
  });

  if (reusable) {
    const result = structuredClone(reusable.provider_result);
    replayProviderResult(context.builder, result);
    await emit(onEvent, 'EVIDENCE_REUSED', {
      provider_id: providerId,
      provider_version: providerVersion,
      dependency_fingerprint: dependencyFingerprint,
      evidence_ids: result.evidence?.map(item => item.id) ?? []
    });
    return {
      ...result,
      reused: true
    };
  }

  await emit(onEvent, 'PROVIDER_STARTED', {
    provider_id: providerId,
    provider_version: providerVersion,
    dependency_fingerprint: dependencyFingerprint
  });

  const result = await acquireAndRecord(provider, context, unit);
  const fidelity = fidelityForProviderResult(result);
  recordProviderAcquisition(explorationLedger, {
    providerId,
    providerVersion,
    dependencyFingerprint,
    cacheScope: 'SNAPSHOT',
    fidelity,
    dependencies: dependencyRefs(result, unit),
    result,
    snapshotId: context.snapshot.snapshot_id
  });

  await emit(
    onEvent,
    result.failures?.length ? 'PROVIDER_FAILED' : 'PROVIDER_COMPLETED',
    {
      provider_id: providerId,
      provider_version: providerVersion,
      dependency_fingerprint: dependencyFingerprint,
      evidence_ids: result.evidence?.map(item => item.id) ?? [],
      failure_codes: result.failures?.map(item => item.code) ?? [],
      metrics: structuredClone(result.metrics ?? {})
    }
  );

  if (result.evidence?.length) {
    await emit(onEvent, 'EVIDENCE_STORED', {
      provider_id: providerId,
      provider_version: providerVersion,
      evidence_ids: result.evidence.map(item => item.id)
    });
  }

  return {
    ...result,
    reused: false
  };
}

export function replayProviderResult(builder, result) {
  if (!builder?.graph) throw new TypeError('GraphBuilder is required');
  if (!result?.provider?.id) throw new TypeError('provider result is required');

  const nodeById = new Map(builder.graph.nodes.map(node => [node.id, node]));

  for (const stored of result.graph_fragment?.nodes ?? []) {
    const {
      id: _id,
      kind,
      key,
      ...data
    } = stored;
    const node = builder.node(kind, key, structuredClone(data));
    nodeById.set(stored.id, node);
  }

  for (const stored of result.graph_fragment?.edges ?? []) {
    const from = nodeById.get(stored.from) ??
      builder.graph.nodes.find(node => node.id === stored.from);
    const to = nodeById.get(stored.to) ??
      builder.graph.nodes.find(node => node.id === stored.to);
    if (!from || !to) {
      throw new Error(
        'cached provider graph fragment has unresolved edge endpoint: ' +
        stored.id
      );
    }
    const {
      id: _id,
      from: _from,
      to: _to,
      type,
      ...data
    } = stored;
    builder.edge(from, to, type, structuredClone(data));
  }

  for (const diagnostic of result.diagnostics ?? []) {
    const {
      level,
      message,
      ...data
    } = diagnostic;
    builder.diagnostic(level, message, structuredClone(data));
  }

  recordProviderResult(builder, {
    ...structuredClone(result),
    dependency_fingerprint: result.dependency_fingerprint
  });

  const latest = builder.graph.meta.providerResults.at(-1);
  if (latest) latest.reused = true;
  return result;
}

export function fidelityForProviderResult(result) {
  let fidelity = 0;
  for (const evidence of result?.evidence ?? []) {
    if (evidence.trust_class === 'RUNTIME_MEASURED') fidelity = Math.max(fidelity, 3);
    else if (evidence.kind === 'STATIC_ANALYSIS') fidelity = Math.max(fidelity, 2);
    else fidelity = Math.max(fidelity, 1);
  }
  return fidelity;
}

function dependencyRefs(result, unit) {
  const refs = [
    'provider:' + result.provider.id + '@' + result.provider.version,
    'dependency:' + result.dependency_fingerprint
  ];
  if (result.unit_ref) refs.push('unit:' + result.unit_ref);
  for (const file of unit.dependencyFiles ?? []) refs.push('file:' + String(file));
  return refs;
}

async function emit(onEvent, type, payload) {
  if (typeof onEvent === 'function') {
    await onEvent(type, structuredClone(payload));
  }
}
