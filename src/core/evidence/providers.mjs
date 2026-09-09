import path from 'node:path';
import { createEvidenceProvider } from './provider.mjs';
import { analyzeJava } from '../../analyzers/java.mjs';
import { analyzeJavaScript } from '../../analyzers/javascript.mjs';
import { analyzeForgeJava, analyzeModsToml } from '../../analyzers/forge.mjs';
import { analyzeForgeNetworkJava } from '../../analyzers/forge-network.mjs';
import { analyzeMinecraftJavaBridge, analyzeMinecraftJson } from '../../analyzers/minecraft.mjs';
import { importCodeGraph } from '../../adapters/codegraph.mjs';
import { importUnderstandAnything } from '../../adapters/understand-anything.mjs';
import { importRuntimeTrace } from '../../adapters/runtime-trace.mjs';
import { importPoseCompanion } from '../../adapters/pose-companion.mjs';
import { importPaletteCompanion } from '../../adapters/palette-companion.mjs';
import { importNetworkCompanion } from '../../adapters/network-companion.mjs';
import { readTraceIdentity } from '../../adapters/kneekura-run-identity.mjs';

export const javaLexicalProvider = createEvidenceProvider({
  id: 'builtin-java',
  version: 'lexical-v1',
  inputKinds: ['java-source'],
  supportedProperties: ['package', 'import', 'class', 'interface', 'enum', 'record', 'method'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'java-lexical-regex-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder, root }, unit) => analyzeJava(builder, unit.file, root),
  unresolved: unresolvedJavaImports,
  observation: (_context, _unit, fragment, value, unresolved, descriptor) => ({
    source_path: value?.rel ?? descriptor.unit_ref,
    graph_delta: summarizeFragment(fragment),
    unresolved_references: unresolved
  })
});

export const javascriptLexicalProvider = createEvidenceProvider({
  id: 'builtin-javascript',
  version: 'lexical-v1',
  inputKinds: ['javascript-source'],
  supportedProperties: [
    'import',
    'reexport',
    'require',
    'class',
    'function',
    'export'
  ],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'javascript-lexical-regex-v1',
  failureClass: 'PARSE_FAILED',
  emitEmptyEvidence: true,
  acquire: ({ builder, root }, unit) =>
    analyzeJavaScript(builder, unit.file, root),
  unresolved:
    unresolvedJavaScriptImports,
  observation:
    (_context, _unit, fragment, value, unresolved, descriptor) => ({
      source_path: value?.rel ?? descriptor.unit_ref,
      graph_delta: summarizeFragment(fragment),
      unresolved_references: unresolved
    })
});

export const forgeJavaProvider = createEvidenceProvider({
  id: 'forge-semantics',
  version: 'v2',
  inputKinds: ['java-analysis'],
  supportedProperties: ['forge-registration', 'forge-event', 'forge-mixin'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'forge-semantic-wrapper-v1',
  acquire: ({ builder }, unit) => analyzeForgeJava(builder, unit.java)
});

export const forgeNetworkProvider = createEvidenceProvider({
  id: 'forge-1.20.1-network',
  version: 'v1',
  inputKinds: ['java-analysis'],
  supportedProperties: ['packet-registration', 'packet-send', 'packet-handler', 'network-channel'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'forge-network-semantic-wrapper-v1',
  acquire: ({ builder }, unit) => analyzeForgeNetworkJava(builder, unit.java)
});

export const minecraftJavaProvider = createEvidenceProvider({
  id: 'minecraft-ysm-semantics',
  version: 'v2',
  inputKinds: ['java-analysis'],
  supportedProperties: ['molang', 'animation', 'bone', 'ysm-bridge'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'minecraft-ysm-java-wrapper-v1',
  acquire: ({ builder }, unit) => analyzeMinecraftJavaBridge(builder, unit.java)
});

export const forgeModsTomlProvider = createEvidenceProvider({
  id: 'forge-mods-toml',
  version: 'v1',
  inputKinds: ['mods-toml'],
  supportedProperties: ['forge-mod-metadata'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'forge-mods-toml-wrapper-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder, root }, unit) => analyzeModsToml(builder, unit.file, root)
});

export const minecraftJsonProvider = createEvidenceProvider({
  id: 'minecraft-ysm-json',
  version: 'v1',
  inputKinds: ['minecraft-json'],
  supportedProperties: ['molang', 'animation', 'bone', 'resource'],
  evidenceKind: 'STATIC_ANALYSIS',
  trustClass: 'REPOSITORY_UNTRUSTED',
  extractionMethod: 'minecraft-json-wrapper-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder, root }, unit) => analyzeMinecraftJson(builder, unit.file, root)
});

export const codeGraphProvider = createEvidenceProvider({
  id: 'codegraph-adapter',
  version: 'v1',
  inputKinds: ['codegraph-artifact'],
  supportedProperties: ['external-codegraph'],
  evidenceKind: 'EXTERNAL',
  trustClass: 'EXTERNAL_UNTRUSTED',
  extractionMethod: 'codegraph-adapter-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importCodeGraph(builder, unit.file)
});

export const understandAnythingProvider = createEvidenceProvider({
  id: 'understand-anything-adapter',
  version: 'wrapper-v1',
  inputKinds: ['understand-anything-artifact'],
  supportedProperties: ['external-understanding'],
  evidenceKind: 'EXTERNAL',
  trustClass: 'EXTERNAL_UNTRUSTED',
  extractionMethod: 'understand-anything-adapter-wrapper-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importUnderstandAnything(builder, unit.file)
});

export const runtimeTraceProvider = createEvidenceProvider({
  id: 'runtime-trace-adapter',
  version: 'v2',
  inputKinds: ['runtime-trace-jsonl'],
  supportedProperties: ['runtime-entity', 'runtime-animation', 'runtime-molang'],
  evidenceKind: 'RUNTIME',
  trustClass: 'RUNTIME_MEASURED',
  extractionMethod: 'kneekura-runtime-trace-jsonl-v2',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importRuntimeTrace(builder, unit.file),
  provenance: (_context, unit) => runtimeRunProvenance(unit.file)
});

export const poseCompanionProvider = createEvidenceProvider({
  id: 'pose-companion-adapter',
  version: 'v1',
  inputKinds: ['runtime-pose-companion'],
  supportedProperties: ['runtime-pose'],
  evidenceKind: 'RUNTIME',
  trustClass: 'RUNTIME_MEASURED',
  extractionMethod: 'kneekura-pose-companion-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importPoseCompanion(builder, unit.file, unit.options ?? {}),
  provenance: (_context, unit) => runtimeRunProvenance(unit.options?.trace),
  classifyDiagnostic: classifyCompanionDiagnostic
});

export const paletteCompanionProvider = createEvidenceProvider({
  id: 'palette-companion-adapter',
  version: 'v1',
  inputKinds: ['runtime-bone-palette'],
  supportedProperties: ['runtime-bone-palette'],
  evidenceKind: 'RUNTIME',
  trustClass: 'RUNTIME_MEASURED',
  extractionMethod: 'kneekura-palette-companion-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importPaletteCompanion(builder, unit.file, unit.options ?? {}),
  provenance: (_context, unit) => runtimeRunProvenance(unit.options?.trace),
  classifyDiagnostic: classifyCompanionDiagnostic
});

export const networkCompanionProvider = createEvidenceProvider({
  id: 'network-companion-adapter',
  version: 'v1',
  inputKinds: ['runtime-network-companion'],
  supportedProperties: ['packet-send', 'packet-receive', 'network-semantic', 'runtime-molang-payload'],
  evidenceKind: 'RUNTIME',
  trustClass: 'RUNTIME_MEASURED',
  extractionMethod: 'kneekura-network-companion-v1',
  failureClass: 'PARSE_FAILED',
  acquire: ({ builder }, unit) => importNetworkCompanion(builder, unit.file, unit.options ?? {}),
  unresolved: unresolvedNetworkStaticMatches,
  classifyDiagnostic: classifyNetworkDiagnostic,
  provenance: (_context, _unit, fragment) => {
    const capture = fragment.nodes.find(node => node.kind === 'runtime_network_capture');
    return capture?.run ? { runtime_run_id: String(capture.run) } : {};
  },
  observation: (_context, _unit, fragment, _value, unresolved, descriptor) => {
    const capture = fragment.nodes.find(node => node.kind === 'runtime_network_capture');
    return {
      artifact_ref: descriptor.unit_ref,
      runtime_run_id: capture?.run ?? null,
      physical_side: capture?.physicalSide ?? null,
      send_event_count: capture?.sendEventCount ?? 0,
      receive_event_count: capture?.receiveEventCount ?? 0,
      semantic_event_count: capture?.semanticEventCount ?? 0,
      graph_delta: summarizeFragment(fragment),
      unresolved_references: unresolved
    };
  }
});

function unresolvedJavaScriptImports(
  context,
  unit,
  fragment
) {
  const refs = [];
  for (const edge of fragment.edges.filter(item =>
    [
      'IMPORTS',
      'REEXPORTS',
      'DYNAMIC_IMPORTS',
      'REQUIRES'
    ].includes(item.type)
  )) {
    const target = context.builder.graph.nodes.find(
      node => node.id === edge.to
    );
    if (!target?.external) continue;
    target.resolution = 'UNRESOLVED';
    target.unresolved = true;
    refs.push({
      kind: 'MODULE_IMPORT',
      path:
        unit.file
          ? path.relative(
              context.root,
              unit.file
            ).replaceAll('\\', '/')
          : null,
      target: target.key,
      edge_type: edge.type,
      resolution: 'UNRESOLVED',
      reason:
        'lexical JavaScript module target is not resolved to a repository file'
    });
  }
  return refs;
}

function unresolvedJavaImports(context, unit, fragment) {
  const refs = [];
  for (const edge of fragment.edges.filter(item => item.type === 'IMPORTS')) {
    const target = context.builder.graph.nodes.find(node => node.id === edge.to);
    if (!target?.external) continue;
    target.resolution = 'UNRESOLVED';
    target.unresolved = true;
    const sourcePath = unit.java?.rel ??
      (unit.file ? path.relative(context.root, unit.file).replaceAll('\\', '/') : null);
    refs.push({
      kind: 'IMPORT',
      path: sourcePath,
      target: target.key,
      resolution: 'UNRESOLVED',
      reason: 'lexical import target is not resolved to a repository symbol'
    });
  }
  return refs;
}

function unresolvedNetworkStaticMatches(_context, _unit, fragment) {
  return fragment.nodes
    .filter(node => node.kind === 'runtime_network_channel' && node.unresolvedStaticChannel)
    .map(node => ({
      kind: 'STATIC_NETWORK_CHANNEL',
      target: node.resourceId ?? node.key,
      resolution: 'UNRESOLVED',
      reason: 'runtime channel has no static network_channel match'
    }));
}

function classifyNetworkDiagnostic(diagnostic) {
  if (diagnostic?.message !== 'network companion rejected') return null;
  const reason = String(diagnostic.reason ?? '').toLowerCase();
  if (reason.includes('invalid')) return { code: 'PARSE_FAILED' };
  if (
    reason.includes('mismatch') ||
    reason.includes('unbound') ||
    reason.includes('no trustworthy run identity') ||
    reason.includes('no rows in measured trace window')
  ) {
    return { code: 'RUNTIME_IDENTITY_MISMATCH' };
  }
  if (
    reason.includes('requires the matching') ||
    reason.includes('no usable meta.gametime')
  ) {
    return { code: 'ANALYZER_UNAVAILABLE' };
  }
  return { code: 'ANALYZER_UNSUPPORTED' };
}

function classifyCompanionDiagnostic(diagnostic) {
  if (!String(diagnostic?.message ?? '').includes('companion rejected')) return null;
  const reason = String(diagnostic.reason ?? '').toLowerCase();
  if (reason.includes('invalid')) return { code: 'PARSE_FAILED' };
  if (reason.includes('mismatch') || reason.includes('does not overlap') || reason.includes('uuid')) {
    return { code: 'RUNTIME_IDENTITY_MISMATCH' };
  }
  return { code: 'ANALYZER_UNSUPPORTED' };
}

async function runtimeRunProvenance(traceFile) {
  if (!traceFile) return {};
  const identity = await readTraceIdentity(traceFile);
  return identity?.run ? { runtime_run_id: String(identity.run) } : {};
}

function summarizeFragment(fragment) {
  const edgeTypes = {};
  for (const edge of fragment.edges) edgeTypes[edge.type] = (edgeTypes[edge.type] ?? 0) + 1;
  const nodeKinds = {};
  for (const node of fragment.nodes) nodeKinds[node.kind] = (nodeKinds[node.kind] ?? 0) + 1;
  return {
    nodes_added: fragment.nodes.length,
    edges_added: fragment.edges.length,
    node_kinds: nodeKinds,
    edge_types: edgeTypes
  };
}