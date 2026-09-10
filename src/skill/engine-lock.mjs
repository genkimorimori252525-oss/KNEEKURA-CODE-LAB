import fs from 'node:fs/promises';

import { ENGINE_IDS, ENGINE_LOCK_SCHEMA } from './contracts.mjs';

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MOVING_REFS = new Set(['main', 'master', 'latest', 'head', 'HEAD']);

export async function readEngineLock(pathname = null) {
  const candidates = pathname == null
    ? [
        new URL('../../engine-lock.json', import.meta.url),
        new URL('../engine-lock.json', import.meta.url)
      ]
    : [pathname];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'));
      validateEngineLock(parsed);
      return parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT' || candidates.length === 1) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('engine lock could not be located');
}

export function validateEngineLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new TypeError('engine lock must be an object');
  if (lock.schema !== ENGINE_LOCK_SCHEMA) throw new TypeError('invalid engine lock schema');
  if (lock.product?.authorityRepository !== 'genkimorimori252525-oss/KNEEKURA-CODE-LAB') {
    throw new TypeError('KNEEKURA-CODE-LAB must own the production engine lock');
  }
  for (const engineId of ENGINE_IDS) {
    if (!lock.engines?.[engineId]) throw new TypeError(`engine lock missing ${engineId}`);
  }
  for (const engineId of ['understand-anything', 'archify']) {
    const engine = lock.engines[engineId];
    if (engine.implementationOrigin !== 'pinned-upstream') throw new TypeError(`${engineId} must be pinned-upstream`);
    if (!FULL_COMMIT.test(engine.commit ?? '')) throw new TypeError(`${engineId} must use an exact commit`);
    if (!engine.release || MOVING_REFS.has(engine.release)) throw new TypeError(`${engineId} release must be immutable`);
    assertIdentity(engine.packageManifest, `${engineId}.packageManifest`);
    assertIdentity(engine.lockfile, `${engineId}.lockfile`);
    assertIdentity(engine.skillContract, `${engineId}.skillContract`);
    assertIdentity(engine.license, `${engineId}.license`);
  }
  if (lock.engines.archify.releaseArtifact?.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(lock.engines.archify.releaseArtifact?.value ?? '')) {
    throw new TypeError('archify stable release artifact must carry sha256 identity');
  }
  if (lock.engines['understand-anything'].viewerReleaseArtifact?.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(lock.engines['understand-anything'].viewerReleaseArtifact?.value ?? '')) {
    throw new TypeError('UA viewer release artifact must carry sha256 identity');
  }
  return true;
}

function assertIdentity(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} identity missing`);
  if (!['git-blob-sha1', 'git-sha1', 'sha256'].includes(value.algorithm)) throw new TypeError(`${label} algorithm missing`);
  const expected = value.algorithm === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (!expected.test(value.value ?? '')) throw new TypeError(`${label} value invalid`);
}
