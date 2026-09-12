import {
  assertDistinctAllContextClaims,
  createAllChildBindings,
  validateAllChildResultManifest,
  validateAllContextClaim
} from './all-mode-contracts.mjs';
import {
  GITHUB_RELAY_SCHEMAS,
  stableRelayJson
} from './contracts.mjs';

export function runGithubRelayAllParentTurn({
  context,
  parentIssueNumber,
  existingPlan = null,
  allChildBindings = [],
  allContextClaims = [],
  allChildResults = []
} = {}) {
  if (!context || typeof context !== 'object') throw new TypeError('ALL parent context is required');
  const issueNumber = positiveInteger(parentIssueNumber, 'parentIssueNumber');
  const expectedBindings = createAllChildBindings({
    parentRunId: context.runId,
    parentIssueNumber: issueNumber,
    request: context.request,
    relayPlan: context.relayPlan
  });
  const recovered = recoverChildBindings(allChildBindings, expectedBindings);
  const actions = [];

  if (!existingPlan) {
    actions.push(Object.freeze({ kind: 'PLAN', envelope: context.relayPlan }));
  }

  for (const expected of expectedBindings) {
    if (recovered.has(expected.engine_id)) continue;
    actions.push(deepFreeze({
      kind: 'ALL_CHILD_CREATE',
      binding: structuredClone(expected),
      child_request: createChildRequest(context.request, expected.engine_id)
    }));
  }

  if (recovered.size !== expectedBindings.length) {
    actions.push(contextsRequiredAction(expectedBindings, recovered, []));
    return freezeAllTurn(context, actions);
  }

  const bindings = expectedBindings.map(expected => recovered.get(expected.engine_id));
  const claims = validateClaims(allContextClaims, bindings);
  if (claims.length !== expectedBindings.length) {
    actions.push(contextsRequiredAction(expectedBindings, recovered, claims));
    return freezeAllTurn(context, actions);
  }

  const results = validateResults(allChildResults, bindings, claims, context.relayPlan);
  if (results.length !== expectedBindings.length) {
    actions.push(deepFreeze({
      kind: 'ALL_CHILDREN_PENDING',
      children: bindings.map(binding => ({
        engine_id: binding.engine_id,
        child_issue_number: binding.child_issue_number,
        host_context_id: claims.find(claim => claim.engine_id === binding.engine_id).host_context_id,
        terminal: results.some(result => result.engine_id === binding.engine_id)
      }))
    }));
    return freezeAllTurn(context, actions);
  }

  actions.push(deepFreeze({
    kind: 'ALL_COMPOSE_REQUIRED',
    parent_run_id: context.runId,
    parent_issue_number: issueNumber,
    children: results
  }));
  return freezeAllTurn(context, actions);
}

function recoverChildBindings(values, expectedBindings) {
  if (!Array.isArray(values)) throw new TypeError('allChildBindings must be an array');
  const expectedBySlot = new Map(expectedBindings.map(binding => [binding.child_slot, binding]));
  const recovered = new Map();
  const issues = new Set();

  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw bindingError('recovered ALL child binding must be an object');
    }
    const slot = Number(value.child_slot);
    const expected = expectedBySlot.get(slot);
    if (!expected) throw bindingError('recovered ALL child binding uses an unknown child slot');
    const childIssueNumber = positiveInteger(value.child_issue_number, 'child_issue_number');
    if (issues.has(childIssueNumber)) throw bindingError('recovered ALL child Issue number is duplicated');
    if (recovered.has(expected.engine_id)) throw bindingError('recovered ALL child slot is duplicated');

    const allowedKeys = new Set([...Object.keys(expected), 'child_issue_number']);
    if (Object.keys(value).some(key => !allowedKeys.has(key))) {
      throw bindingError('recovered ALL child binding contains unsupported fields');
    }
    const projected = Object.fromEntries(Object.keys(expected).map(key => [key, value[key]]));
    if (stableRelayJson(projected) !== stableRelayJson(expected)) {
      throw bindingError('recovered ALL child binding drifted from the immutable parent-authorized slot');
    }

    recovered.set(expected.engine_id, deepFreeze({
      ...structuredClone(expected),
      child_issue_number: childIssueNumber
    }));
    issues.add(childIssueNumber);
  }
  return recovered;
}

function validateClaims(values, bindings) {
  if (!Array.isArray(values)) throw new TypeError('allContextClaims must be an array');
  const bindingByEngine = new Map(bindings.map(binding => [binding.engine_id, binding]));
  const claims = [];
  const seen = new Set();
  for (const value of values) {
    const engineId = String(value?.engine_id ?? '');
    const binding = bindingByEngine.get(engineId);
    if (!binding) throw isolationError('ALL context claim targets an unknown child engine slot');
    if (seen.has(engineId)) throw isolationError('ALL child engine has multiple context claims');
    claims.push(validateAllContextClaim(value, binding));
    seen.add(engineId);
  }
  assertDistinctAllContextClaims(claims);
  return claims;
}

function validateResults(values, bindings, claims, parentPlan) {
  if (!Array.isArray(values)) throw new TypeError('allChildResults must be an array');
  const bindingByEngine = new Map(bindings.map(binding => [binding.engine_id, binding]));
  const claimByEngine = new Map(claims.map(claim => [claim.engine_id, claim]));
  const results = [];
  const seen = new Set();
  for (const value of values) {
    const engineId = String(value?.engine_id ?? '');
    const binding = bindingByEngine.get(engineId);
    if (!binding) throw bindingError('ALL child result targets an unknown engine slot');
    if (seen.has(engineId)) throw bindingError('ALL child engine has multiple terminal result manifests');
    const result = validateAllChildResultManifest(value, binding, parentPlan);
    const claim = claimByEngine.get(engineId);
    if (!claim || result.host_context_id !== claim.host_context_id || result.assurance_class !== claim.assurance_class) {
      throw isolationError('ALL child result context identity does not match the accepted context claim');
    }
    results.push(result);
    seen.add(engineId);
  }
  return results;
}

function createChildRequest(parentRequest, engineId) {
  return deepFreeze({
    schema: GITHUB_RELAY_SCHEMAS.request,
    selection: engineId,
    target: structuredClone(parentRequest.target),
    commonScope: structuredClone(parentRequest.commonScope ?? {}),
    engineOptions: projectEngineMap(parentRequest.engineOptions, engineId),
    minimumClaimLevel: projectEngineMap(parentRequest.minimumClaimLevel, engineId),
    semanticContextMode: 'single-context'
  });
}

function projectEngineMap(value, engineId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value[engineId] == null) return {};
  return { [engineId]: structuredClone(value[engineId]) };
}

function contextsRequiredAction(expectedBindings, recovered, claims) {
  const claimByEngine = new Map(claims.map(claim => [claim.engine_id, claim]));
  return deepFreeze({
    kind: 'ALL_CONTEXTS_REQUIRED',
    children: expectedBindings.map(expected => {
      const binding = recovered.get(expected.engine_id);
      const claim = claimByEngine.get(expected.engine_id);
      return {
        engine_id: expected.engine_id,
        child_slot: expected.child_slot,
        child_issue_number: binding?.child_issue_number ?? null,
        child_request_digest: expected.child_request_digest,
        context_claimed: Boolean(claim),
        host_context_id: claim?.host_context_id ?? null
      };
    })
  });
}

function freezeAllTurn(context, actions) {
  return deepFreeze({
    schema: 'kneekura.code-lab.github-relay-turn/v1',
    run_id: context.runId,
    relay_plan: context.relayPlan,
    replay: null,
    actions
  });
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function bindingError(message) {
  return codedError('ALL_CHILD_BINDING_MISMATCH', message);
}

function isolationError(message) {
  return codedError('BLOCKED_SEMANTIC_CONTEXT_ISOLATION', message);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}