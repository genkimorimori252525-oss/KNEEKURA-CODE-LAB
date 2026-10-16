export {
  toJollyResearchMailbox,
  toJollyResearchMailboxServiceResult,
  JOLLY_MAILBOX_ENTRY_SCHEMA,
  JOLLY_MAILBOX_SERVICE_RESULT_SCHEMA,
  JOLLY_MAILBOX_SERVICE,
  JOLLY_MAILBOX_ANALYSIS_MODES
} from './adapters/jolly-research-mailbox.mjs';

export {
  renderJollyResearchMailboxServiceResultMarkdown,
  validateJollyResearchMailboxServiceResultV1
} from './adapters/jolly-research-mailbox-result-md.mjs';

export {
  JOLLY_MAILBOX_CORE_MODE_MAP,
  parseJollyResearchMailboxRequestMarkdown,
  toJollyResearchMailboxCoreExecutionPlan,
  validateJollyResearchMailboxRequest
} from './adapters/jolly-research-mailbox-request.mjs';

export {
  runJollyResearchMailboxRequest
} from './adapters/jolly-research-mailbox-runner.mjs';

// Import-only machine renderer; human artifacts remain a separate surface.
export {projectWorkbenchForAgent, renderWorkbenchAgentMarkdown} from './analysis-workbench/render.mjs';
export {runEvidenceWorkbench} from './analysis-workbench/index.mjs';
