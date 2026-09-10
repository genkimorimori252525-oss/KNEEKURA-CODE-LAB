import { ENGINE_IDS, normalizeAnalysisRequest } from './contracts.mjs';

export function routeKneekuraCodeLabRequest(input = {}) {
  const request = normalizeAnalysisRequest(input);
  if (request.selectionRequired) {
    return {
      kind: 'SELECTION_REQUIRED',
      choices: [...ENGINE_IDS],
      request
    };
  }
  return {
    kind: 'RUN',
    requestedEngines: [...request.requestedEngines],
    request
  };
}

export function assertNoEngineSubstitution(requestedEngine, actualEngine) {
  if (!ENGINE_IDS.includes(requestedEngine) || !ENGINE_IDS.includes(actualEngine)) {
    throw new TypeError('engine must be a KNEEKURA Code LAB v1 engine');
  }
  if (requestedEngine !== actualEngine) {
    const error = new Error(`engine substitution forbidden: requested ${requestedEngine}, got ${actualEngine}`);
    error.code = 'ENGINE_SUBSTITUTION_FORBIDDEN';
    throw error;
  }
  return true;
}