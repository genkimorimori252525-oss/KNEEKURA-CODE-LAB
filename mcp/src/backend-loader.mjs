import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadKneekuraCodeLabBackendFromEnvironment({
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const specifier = String(
    env.KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE ?? ''
  ).trim();
  if (!specifier) return null;

  const url = specifier.startsWith('file:')
    ? new URL(specifier)
    : pathToFileURL(path.resolve(cwd, specifier));
  const module = await import(url.href);
  const backend = typeof module.createBackend === 'function'
    ? await module.createBackend()
    : module.backend;

  if (!backend || typeof backend !== 'object') {
    throw new TypeError(
      'MCP backend module must export backend or createBackend()'
    );
  }
  return backend;
}