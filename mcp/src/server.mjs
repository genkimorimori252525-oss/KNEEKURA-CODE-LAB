import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  createKneekuraCodeLabMcpAdapter,
  formatMcpAdapterError
} from './adapter.mjs';
import { loadKneekuraCodeLabBackendFromEnvironment } from './backend-loader.mjs';

const selectionSchema = z.enum([
  'kneekura',
  'understand-anything',
  'archify',
  'all'
]);
const targetSchema = z.object({
  repository: z.string().min(1).max(500),
  revision: z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/),
  snapshotId: z.string().regex(/^snapshot:sha256:[0-9a-fA-F]{64}$/),
  scopeDigest: z.string().regex(/^sha256:[0-9a-fA-F]{64}$/)
}).strict();
const jsonObjectSchema = z.record(z.string(), z.unknown());
const executionRequestSchema = z.object({
  selection: selectionSchema.optional(),
  target: targetSchema,
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  commonScope: jsonObjectSchema.optional(),
  engineOptions: jsonObjectSchema.optional(),
  minimumClaimLevel: jsonObjectSchema.optional()
}).strict();

export function createKneekuraCodeLabMcpServer({ adapter } = {}) {
  const activeAdapter = adapter ?? createKneekuraCodeLabMcpAdapter();
  const server = new McpServer({
    name: 'kneekura-code-lab',
    version: '1.0.0'
  });

  server.registerTool(
    'kneekura_code_lab_describe',
    {
      description: 'Describe KNEEKURA Code LAB engines, safety invariants, and backend readiness.',
      inputSchema: z.object({}).strict()
    },
    async () => toolResult(() => activeAdapter.describe())
  );

  server.registerTool(
    'kneekura_code_lab_plan',
    {
      description: 'Validate explicit engine selection and an immutable KNEEKURA target identity without executing analysis.',
      inputSchema: executionRequestSchema
    },
    async input => toolResult(() => activeAdapter.plan(input))
  );

  server.registerTool(
    'kneekura_code_lab_execute',
    {
      description: 'Execute a validated KNEEKURA Code LAB request through the configured backend. No engine substitution is permitted.',
      inputSchema: executionRequestSchema
    },
    async input => toolResult(() => activeAdapter.execute(input))
  );

  server.registerTool(
    'kneekura_code_lab_status',
    {
      description: 'Read bounded operational status for a known KNEEKURA Code LAB run id.',
      inputSchema: z.object({
        runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      }).strict()
    },
    async input => toolResult(() => activeAdapter.status(input))
  );

  server.registerTool(
    'kneekura_code_lab_artifact_info',
    {
      description: 'Read sanitized artifact identity and locator metadata without embedding artifact bytes.',
      inputSchema: z.object({
        runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        artifactId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional()
      }).strict()
    },
    async input => toolResult(() => activeAdapter.artifactInfo(input))
  );

  return server;
}

export async function startKneekuraCodeLabStdioServer() {
  const backend = await loadKneekuraCodeLabBackendFromEnvironment();
  const adapter = createKneekuraCodeLabMcpAdapter({ backend });
  return serveStdio(() => createKneekuraCodeLabMcpServer({ adapter }));
}

async function toolResult(operation) {
  try {
    const value = await operation();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }]
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify(formatMcpAdapterError(error), null, 2)
      }]
    };
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  await startKneekuraCodeLabStdioServer();
}