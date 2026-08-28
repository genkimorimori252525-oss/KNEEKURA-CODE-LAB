import {
  parseJollyResearchMailboxRequestMarkdown,
  toJollyResearchMailboxCoreExecutionPlan
} from './jolly-research-mailbox-request.mjs';

import {
  toJollyResearchMailboxServiceResult
} from './jolly-research-mailbox.mjs';

import {
  renderJollyResearchMailboxServiceResultMarkdown
} from './jolly-research-mailbox-result-md.mjs';

export async function runJollyResearchMailboxRequest(
  requestMarkdown,
  {
    repository,
    core,
    analyzeOptions = {},
    policy = 'balanced',
    outputProfile = 'standard'
  } = {}
) {
  if (
    core == null ||
    typeof core !== 'object' ||
    typeof core.analyze !== 'function'
  ) {
    throw new TypeError(
      'core with an analyze(request, options) function is required'
    );
  }

  if (
    analyzeOptions == null ||
    typeof analyzeOptions !== 'object' ||
    Array.isArray(analyzeOptions)
  ) {
    throw new TypeError(
      'analyzeOptions must be an object'
    );
  }

  const job =
    parseJollyResearchMailboxRequestMarkdown(
      requestMarkdown
    );

  const plan =
    toJollyResearchMailboxCoreExecutionPlan(
      job,
      {
        repository,
        policy,
        outputProfile
      }
    );

  const analysisResult =
    await core.analyze(
      plan.core_request,
      analyzeOptions
    );

  const serviceResult =
    toJollyResearchMailboxServiceResult(
      analysisResult,
      plan.service_result_options
    );

  const resultMarkdown =
    renderJollyResearchMailboxServiceResultMarkdown(
      serviceResult
    );

  return {
    job: structuredClone(job),
    execution_plan: structuredClone(plan),
    analysis_result: structuredClone(analysisResult),
    service_result: structuredClone(serviceResult),
    result_markdown: resultMarkdown
  };
}
