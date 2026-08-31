import {
  stableDigest,
  validateHumanAnalysisIr
} from './schema.mjs';
import {
  assertAcceptanceSemanticAuthor,
  assertProductionSemanticAuthor,
  describeHumanAnalysisAuthor
} from './author-contract.mjs';
import { runHumanAnalysisSemanticPipeline } from './pipeline.mjs';

export const HUMAN_ANALYSIS_GENERATION_SCHEMA =
  'kneekura.human-analysis-generation/v1';

export class HumanAnalysisProductionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'HumanAnalysisProductionError';
    this.code = String(code);
  }
}

export async function runProductionHumanAnalysisSemanticPipeline({
  evidencePack,
  sourceBroker,
  semanticAuthor,
  request = {}
} = {}) {
  if (semanticAuthor == null) {
    throw new HumanAnalysisProductionError(
      'PRODUCTION_AUTHOR_REQUIRED',
      'production Human Guide generation requires an explicit PRODUCTION semantic author; acceptance fallback is forbidden'
    );
  }
  const author = assertProductionSemanticAuthor(semanticAuthor);
  return runDescribedPipeline({
    evidencePack,
    sourceBroker,
    semanticAuthor: author,
    request,
    mode: 'PRODUCTION'
  });
}

export async function runAcceptanceHumanAnalysisSemanticPipeline({
  evidencePack,
  sourceBroker,
  semanticAuthor,
  request = {}
} = {}) {
  if (semanticAuthor == null) {
    throw new HumanAnalysisProductionError(
      'ACCEPTANCE_AUTHOR_REQUIRED',
      'acceptance Human Analysis requires an explicit ACCEPTANCE semantic author'
    );
  }
  const author = assertAcceptanceSemanticAuthor(semanticAuthor);
  return runDescribedPipeline({
    evidencePack,
    sourceBroker,
    semanticAuthor: author,
    request,
    mode: 'ACCEPTANCE'
  });
}

export function assertProductionHumanAnalysisIr(ir) {
  validateHumanAnalysisIr(ir);
  if (
    ir.generation?.schema !== HUMAN_ANALYSIS_GENERATION_SCHEMA ||
    ir.generation?.mode !== 'PRODUCTION' ||
    ir.generation?.user_deliverable !== true ||
    ir.generation?.semantic_author?.mode !== 'PRODUCTION' ||
    ir.generation?.semantic_author?.acceptance_fixture !== false
  ) {
    throw new HumanAnalysisProductionError(
      'PRODUCTION_IR_REQUIRED',
      'user-deliverable Human Guide requires Human Analysis IR produced by the PRODUCTION author contract'
    );
  }
  return true;
}

export function assertAcceptanceHumanAnalysisIr(ir) {
  validateHumanAnalysisIr(ir);
  if (
    ir.generation?.schema !== HUMAN_ANALYSIS_GENERATION_SCHEMA ||
    ir.generation?.mode !== 'ACCEPTANCE' ||
    ir.generation?.user_deliverable !== false ||
    ir.generation?.semantic_author?.mode !== 'ACCEPTANCE' ||
    ir.generation?.semantic_author?.acceptance_fixture !== true
  ) {
    throw new HumanAnalysisProductionError(
      'ACCEPTANCE_IR_REQUIRED',
      'acceptance validation requires Human Analysis IR produced by the ACCEPTANCE author contract'
    );
  }
  return true;
}

async function runDescribedPipeline({
  evidencePack,
  sourceBroker,
  semanticAuthor,
  request,
  mode
}) {
  const base = await runHumanAnalysisSemanticPipeline({
    evidencePack,
    sourceBroker,
    author: semanticAuthor.run,
    request
  });
  const ir = structuredClone(base);
  delete ir.ir_digest;
  ir.generation = {
    schema: HUMAN_ANALYSIS_GENERATION_SCHEMA,
    mode,
    user_deliverable: mode === 'PRODUCTION',
    fallback_to_acceptance_forbidden: true,
    semantic_author: structuredClone(
      describeHumanAnalysisAuthor(semanticAuthor)
    )
  };
  ir.ir_digest = stableDigest(ir);
  validateHumanAnalysisIr(ir);
  return deepFreeze(ir);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
