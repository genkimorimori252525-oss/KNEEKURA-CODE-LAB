import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeterministicZip } from '../src/human-analysis/zip.mjs';

export const SKILL_DISTRIBUTION_SCHEMA =
  'kneekura.code-lab.skill-distribution/v1';

export const SKILL_DISTRIBUTION_FILES = Object.freeze([
  Object.freeze({
    source: 'skills/kneekura-code-lab/SKILL.md',
    target: 'SKILL.md',
    content: 'utf8-lf'
  }),
  Object.freeze({
    source: 'skills/kneekura-code-lab/references/INSTALL.md',
    target: 'references/INSTALL.md',
    content: 'utf8-lf'
  }),
  Object.freeze({
    source: 'skills/kneekura-code-lab/references/MCP.md',
    target: 'references/MCP.md',
    content: 'utf8-lf'
  })
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.dirname(HERE);

export async function buildKneekuraCodeLabSkillDistribution({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  outputRoot = path.join(repositoryRoot, 'dist', 'chatgpt-skill'),
  write = true
} = {}) {
  const root = path.resolve(repositoryRoot);
  const output = path.resolve(outputRoot);
  const entries = [];
  const manifestFiles = [];

  for (const descriptor of SKILL_DISTRIBUTION_FILES) {
    const sourcePath = path.join(root, descriptor.source);
    const sourceBytes = await fs.readFile(sourcePath);
    const data = normalizeDistributionContent(sourceBytes, descriptor.content);
    entries.push({ path: descriptor.target, data });
    manifestFiles.push({
      path: descriptor.target,
      source: descriptor.source,
      content: descriptor.content,
      bytes: data.length,
      sha256: `sha256:${sha256(data)}`
    });
  }

  manifestFiles.sort((a, b) => compareText(a.path, b.path));
  const manifest = Object.freeze({
    schema: SKILL_DISTRIBUTION_SCHEMA,
    name: 'kneekura-code-lab',
    distribution_version: 'v1',
    entrypoint: 'SKILL.md',
    execution_contract: 'references/MCP.md',
    deterministic: true,
    text_normalization: 'LF',
    contains_engine_implementation: false,
    files: manifestFiles
  });
  const manifestBytes = Buffer.from(stableJson(manifest), 'utf8');
  entries.push({ path: 'skill-distribution.json', data: manifestBytes });

  const zip = createDeterministicZip(entries, { root: 'kneekura-code-lab' });
  const zipDigest = `sha256:${sha256(zip)}`;
  const result = Object.freeze({
    schema: SKILL_DISTRIBUTION_SCHEMA,
    outputRoot: output,
    directory: path.join(output, 'kneekura-code-lab'),
    zipPath: path.join(output, 'kneekura-code-lab.zip'),
    zipDigest,
    zipBytes: zip.length,
    manifest
  });

  if (write) {
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(result.directory, { recursive: true });
    for (const entry of entries) {
      const destination = safeJoin(result.directory, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.data);
    }
    await fs.writeFile(result.zipPath, zip);
    await fs.writeFile(
      `${result.zipPath}.sha256`,
      `${zipDigest.slice('sha256:'.length)}  kneekura-code-lab.zip\n`,
      'utf8'
    );
  }

  return result;
}

function normalizeDistributionContent(value, content) {
  if (content !== 'utf8-lf') {
    throw new TypeError(`unsupported Skill distribution content mode: ${content}`);
  }
  const text = Buffer.from(value).toString('utf8').replace(/\r\n?/g, '\n');
  return Buffer.from(text, 'utf8');
}

function safeJoin(root, relative) {
  const normalized = String(relative ?? '').replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`unsafe distribution path: ${relative}`);
  }
  const destination = path.resolve(root, ...normalized.split('/'));
  const prefix = path.resolve(root) + path.sep;
  if (!destination.startsWith(prefix)) {
    throw new TypeError(`distribution path escapes root: ${relative}`);
  }
  return destination;
}

function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2) + '\n';
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map(key => [key, sortValue(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildKneekuraCodeLabSkillDistribution();
  process.stdout.write(stableJson({
    schema: result.schema,
    directory: result.directory,
    zip_path: result.zipPath,
    zip_digest: result.zipDigest,
    zip_bytes: result.zipBytes,
    file_count: result.manifest.files.length + 1
  }));
}