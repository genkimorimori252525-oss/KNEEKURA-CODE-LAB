import path from 'node:path';
import { runJollyResearchMailboxRequest } from '../src/mailbox.mjs';
import { analyzeInternal } from '../src/core/api/analyze.mjs';

const TARGET_COMMIT = 'f9f01c9d3357f2d795b90152a1095423423db2fd';
const TARGET_REPOSITORY = 'genkimorimori252525-oss/KNEEKURA-LAB';

const targetRoot = path.resolve(process.argv[2] || '../KNEEKURA-LAB');

let captured = null;
const core = {
  async analyze(request, options) {
    captured = await analyzeInternal(request, options);
    return structuredClone(captured.result);
  }
};

const targetPaths = [
  'simlab/viewer/gl.js',
  'simlab/viewer/ysm.js',
  'simlab/serve.mjs',
  'simlab/pose.mjs',
  'simlab/contracts/render-v1/validator.mjs',
  'simlab/contracts/render-v1/constants.mjs',
  'bridge/tlm-forge/src/main/java/com/github/tartaricacid/touhoulittlemaid/sim/client/SimModelDump.java',
  'bridge/tlm-forge/src/main/java/com/github/tartaricacid/touhoulittlemaid/sim/client/SimPoseDump.java',
  'bridge/tlm-forge/src/main/java/com/github/tartaricacid/touhoulittlemaid/sim/client/SimBonePalette.java',
  'bridge/tlm-forge/src/main/java/com/github/tartaricacid/touhoulittlemaid/sim/client/SimPaletteTrace.java'
];

const requestMarkdown = `# KNEEKURA CODE-LAB Investigation

id: YSM-RENDER-PARITY-${TARGET_COMMIT.slice(0, 12)}
status: pending
service: kneekura-code-lab
priority: high
max_output_tokens: 5000

source_repository: ${TARGET_REPOSITORY}
source_ref: main
source_commit: ${TARGET_COMMIT}
source_issue:
source_pull_request:
project: KNEEKURA-LAB
requested_by: jolly

analysis_mode: bug_hunt

## Question

Why does the KNEEKURA-LAB YSM Viewer still fail to render with Minecraft/YSM runtime fidelity? Trace where authoritative runtime render information is captured, where it is reduced or discarded, where the Viewer falls back to reconstructed YSM semantics, and whether Render Pack / RenderFrame v1 contracts are actually wired into the runtime Viewer. Identify evidence-backed implementation gaps and preserve UNKNOWN for native YSM internals.

## Target paths

${targetPaths.map(p => '- `' + p + '`').join('\n')}

## Known symptoms / observations

- The Viewer does not look the same as Minecraft/YSM runtime rendering.
- Runtime pose/palette companions exist, but reconstructed YSM rendering remains present.
- Render Architecture v1 requires authoritative Render Pack + RenderFrame replay and forbids authoritative Viewer-side YSM reconstruction.

## Constraints

- Analyze only the pinned source commit.
- Do not modify KNEEKURA-LAB.
- Do not invent native YSM skinning internals.
- Distinguish captured final vertices, palette-derived transforms, reconstructed animation state, material state, and Viewer fallbacks.

## Required output

Produce conservative evidence suitable for an implementation plan. Do not fabricate root cause or source-change authority.

## Exclusions

- No external web research.
- No claims about Minecraft/YSM native internals beyond captured or source-visible boundaries.
`;

const output = await runJollyResearchMailboxRequest(requestMarkdown, {
  repository: targetRoot,
  core,
  policy: 'precision',
  outputProfile: 'forensic'
});

if (!captured) throw new Error('analysis state was not captured');

const graph = captured.state.graph;
const selected = new Set(targetPaths);
const nodes = (graph.nodes || []).filter(n => selected.has(n.path) || selected.has(n.key));
const nodeIds = new Set(nodes.map(n => n.id));
const edges = (graph.edges || []).filter(e => nodeIds.has(e.from) || nodeIds.has(e.to));
const evidence = (graph.meta?.evidence || []).filter(e => selected.has(e.provenance?.path));

const diagnostic = {
  target: {
    repository: TARGET_REPOSITORY,
    commit: TARGET_COMMIT
  },
  canonical: {
    status: output.analysis_result.status,
    coverage: output.analysis_result.coverage?.completeness,
    claims: output.analysis_result.claims?.length || 0,
    evidence: output.analysis_result.evidence?.length || 0,
    unknowns: output.analysis_result.unknowns?.length || 0,
    warnings: output.analysis_result.warnings || [],
    failures: output.analysis_result.failures || []
  },
  mailbox: {
    status: output.service_result.status,
    confidence: output.service_result.confidence,
    root_cause: output.service_result.root_cause,
    remaining_uncertainty: output.service_result.remaining_uncertainty
  },
  selected: {
    paths: targetPaths,
    nodes: nodes.map(n => ({id:n.id,kind:n.kind,key:n.key,path:n.path,label:n.label,language:n.language})),
    edges: edges.map(e => ({id:e.id,type:e.type,from:e.from,to:e.to,source:e.source,specifier:e.specifier})),
    evidence: evidence.map(e => ({
      id:e.id,
      kind:e.kind,
      provider_id:e.provider_id,
      trust_class:e.trust_class,
      path:e.provenance?.path,
      observation:e.observation
    }))
  },
  unresolved: graph.meta?.unresolvedReferences || [],
  provider_failures: graph.meta?.providerFailures || []
};

console.log('KNEEKURA_YSM_INVESTIGATION_JSON_BEGIN');
console.log(JSON.stringify(diagnostic, null, 2));
console.log('KNEEKURA_YSM_INVESTIGATION_JSON_END');
console.log('KNEEKURA_YSM_RESULT_MD_BEGIN');
console.log(output.result_markdown);
console.log('KNEEKURA_YSM_RESULT_MD_END');
