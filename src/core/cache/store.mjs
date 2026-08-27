import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_TIERS,
  canonicalDependencies,
  dependencyFingerprint,
  contentDigest,
  digestObject
} from './fingerprint.mjs';

export const CACHE_ARTIFACT_SCHEMA = 'core.cache-artifact/v1';

export function createCacheStore({
  storageRoot,
  targetRepositoryRoot = null
}) {
  const root = path.resolve(String(storageRoot ?? ''));
  if (!storageRoot) throw new TypeError('storageRoot is required');
  assertCoreOwnedStorage(root, targetRepositoryRoot);

  return Object.freeze({
    root,

    async putBlob(value, metadata = {}) {
      const bytes = cacheBytes(value);
      const digest = contentDigest(bytes);
      const key = 'c0:' + digest;
      const dir = path.join(root, 'cache', 'C0');
      await fs.mkdir(dir, { recursive: true });
      const blobPath = path.join(dir, digest.slice('sha256:'.length) + '.blob');
      const metaPath = path.join(dir, digest.slice('sha256:'.length) + '.json');

      if (!(await exists(blobPath))) await fs.writeFile(blobPath, bytes);
      if (!(await exists(metaPath))) {
        await writeJsonAtomic(metaPath, {
          schema: CACHE_ARTIFACT_SCHEMA,
          tier: 'C0',
          key,
          content_digest: digest,
          dependencies: [],
          dependency_fingerprint: dependencyFingerprint([]),
          metadata: structuredClone(metadata)
        });
      }

      return {
        hit: false,
        artifact: {
          schema: CACHE_ARTIFACT_SCHEMA,
          tier: 'C0',
          key,
          content_digest: digest,
          path: blobPath
        }
      };
    },

    async getBlob(keyOrDigest) {
      const digest = String(keyOrDigest).replace(/^c0:/, '');
      if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
        return { hit: false, reason: 'INVALID_KEY' };
      }
      const blobPath = path.join(
        root,
        'cache',
        'C0',
        digest.slice('sha256:'.length) + '.blob'
      );
      try {
        const bytes = await fs.readFile(blobPath);
        if (contentDigest(bytes) !== digest) {
          return { hit: false, reason: 'CONTENT_DIGEST_MISMATCH' };
        }
        return {
          hit: true,
          artifact: {
            schema: CACHE_ARTIFACT_SCHEMA,
            tier: 'C0',
            key: 'c0:' + digest,
            content_digest: digest,
            bytes
          }
        };
      } catch (error) {
        if (error?.code === 'ENOENT') return { hit: false, reason: 'NOT_FOUND' };
        throw error;
      }
    },

    async putArtifact({
      tier,
      key,
      dependencies = [],
      payload,
      metadata = {}
    }) {
      assertTier(tier);
      if (tier === 'C0') throw new TypeError('use putBlob for C0');
      requireString(key, 'key');

      const normalizedDependencies = canonicalDependencies(dependencies);
      const identity = {
        schema: CACHE_ARTIFACT_SCHEMA,
        tier,
        key,
        dependencies: normalizedDependencies,
        dependency_fingerprint: dependencyFingerprint(normalizedDependencies),
        payload: jsonPersistable(payload)
      };
      const record = {
        ...identity,
        artifact_digest: digestObject(identity),
        metadata: jsonPersistable(metadata)
      };
      const file = artifactPath(root, tier, key);
      await fs.mkdir(path.dirname(file), { recursive: true });

      if (await exists(file)) {
        const existing = JSON.parse(await fs.readFile(file, 'utf8'));
        validateArtifactRecord(existing, tier, key);
        const existingIdentity = artifactIdentity(existing);
        const incomingIdentity = artifactIdentity(record);
        if (stableJson(existingIdentity) !== stableJson(incomingIdentity)) {
          throw new Error('cache key collision with different content: ' + key);
        }
        return { hit: true, reused: true, artifact: existing };
      }

      await writeJsonAtomic(file, record);
      return { hit: false, reused: false, artifact: record };
    },

    async getArtifact({
      tier,
      key,
      expectedDependencies = null
    }) {
      assertTier(tier);
      if (tier === 'C0') throw new TypeError('use getBlob for C0');
      requireString(key, 'key');

      const file = artifactPath(root, tier, key);
      let record;
      try {
        record = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return { hit: false, reason: 'NOT_FOUND' };
        throw error;
      }

      validateArtifactRecord(record, tier, key);

      if (expectedDependencies != null) {
        const expected = dependencyFingerprint(
          canonicalDependencies(expectedDependencies)
        );
        if (record.dependency_fingerprint !== expected) {
          return {
            hit: false,
            reason: 'DEPENDENCY_MISMATCH',
            artifact: record
          };
        }
      }

      return {
        hit: true,
        artifact: structuredClone(record)
      };
    },

    async invalidate({ tier, key, reason = 'DEPENDENCY_CHANGED' }) {
      assertTier(tier);
      if (tier === 'C0') {
        throw new TypeError('immutable C0 blobs are not invalidated');
      }
      const file = artifactPath(root, tier, key);
      if (!(await exists(file))) return { invalidated: false, reason: 'NOT_FOUND' };
      const tombstone = file + '.invalidated.json';
      await writeJsonAtomic(tombstone, {
        schema: 'core.cache-invalidation/v1',
        tier,
        key,
        reason: String(reason)
      });
      await fs.unlink(file);
      return { invalidated: true, reason: String(reason) };
    }
  });
}

export function assertCoreOwnedStorage(storageRoot, targetRepositoryRoot) {
  if (!targetRepositoryRoot) return true;
  const storage = path.resolve(String(storageRoot));
  const target = path.resolve(String(targetRepositoryRoot));
  const relative = path.relative(target, storage);
  if (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('CORE storage must not be inside the target repository');
  }
  return true;
}

function artifactPath(root, tier, key) {
  const encoded = Buffer.from(key).toString('base64url');
  return path.join(root, 'cache', tier, encoded + '.json');
}

function validateArtifactRecord(record, tier, key) {
  if (!record || record.schema !== CACHE_ARTIFACT_SCHEMA) {
    throw new Error('invalid cache artifact schema');
  }
  if (record.tier !== tier || record.key !== key) {
    throw new Error('cache artifact identity mismatch');
  }
  const expected = dependencyFingerprint(
    canonicalDependencies(record.dependencies ?? [])
  );
  if (record.dependency_fingerprint !== expected) {
    throw new Error('cache artifact dependency fingerprint mismatch');
  }
  const expectedArtifactDigest = digestObject(artifactIdentity(record));
  if (record.artifact_digest !== expectedArtifactDigest) {
    throw new Error('cache artifact content digest mismatch');
  }
}

function artifactIdentity(record) {
  return {
    schema: record.schema,
    tier: record.tier,
    key: record.key,
    dependencies: canonicalDependencies(record.dependencies ?? []),
    dependency_fingerprint: record.dependency_fingerprint,
    payload: structuredClone(record.payload)
  };
}

function assertTier(tier) {
  if (!CACHE_TIERS.includes(tier)) throw new TypeError('invalid cache tier: ' + tier);
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}

function jsonPersistable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function cacheBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('C0 blob input must be a string, Buffer, or Uint8Array');
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
