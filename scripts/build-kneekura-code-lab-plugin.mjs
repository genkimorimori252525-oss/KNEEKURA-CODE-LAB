import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeterministicZip } from '../src/human-analysis/zip.mjs';

export const PLUGIN_DISTRIBUTION_SCHEMA =
  'kneekura.code-lab.plugin-distribution/v1';
export const PLUGIN_DISTRIBUTION_VERSION = '1.0.0';
export const PLUGIN_ESBUILD_VERSION = '0.25.10';

export const PLUGIN_STATIC_FILES = Object.freeze([
  Object.freeze({ source: 'plugin/kneekura-code-lab/.codex-plugin/plugin.json', target: '.codex-plugin/plugin.json' }),
  Object.freeze({ source: 'plugin/kneekura-code-lab/.mcp.json', target: '.mcp.json' }),
  Object.freeze({ source: 'plugin/kneekura-code-lab/README.md', target: 'README.md' }),
  Object.freeze({ source: 'skills/kneekura-code-lab/SKILL.md', target: 'skills/kneekura-code-lab/SKILL.md' }),
  Object.freeze({ source: 'skills/kneekura-code-lab/references/INSTALL.md', target: 'skills/kneekura-code-lab/references/INSTALL.md' }),
  Object.freeze({ source: 'skills/kneekura-code-lab/references/MCP.md', target: 'skills/kneekura-code-lab/references/MCP.md' })
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.dirname(HERE);

export async function buildKneekuraCodeLabPluginDistribution({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  outputRoot = path.join(repositoryRoot, 'dist', 'chatgpt-plugin'),
  write = true,
  bundleMcp = bundleMcpServer
} = {}) {
  const root = path.resolve(repositoryRoot);
  const output = path.resolve(outputRoot);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-code-lab-plugin-'));

  try {
    const entries = [];
    const manifestFiles = [];

    for (const descriptor of PLUGIN_STATIC_FILES) {
      const sourcePath = path.join(root, descriptor.source);
      const data = normalizeTextBytes(await fs.readFile(sourcePath));
      entries.push({ path: descriptor.target, data });
      manifestFiles.push(fileRecord(descriptor.target, descriptor.source, data));
    }

    const mcpBundle = normalizeTextBytes(await bundleMcp({
      repositoryRoot: root,
      tempRoot
    }));
    entries.push({ path: 'mcp/server.mjs', data: mcpBundle });
    manifestFiles.push(fileRecord(
      'mcp/server.mjs',
      'generated:mcp/src/server.mjs',
      mcpBundle
    ));

    manifestFiles.sort((a, b) => compareText(a.path, b.path));
    const manifest = {
      schema: PLUGIN_DISTRIBUTION_SCHEMA,
      name: 'kneekura-code-lab',
      version: PLUGIN_DISTRIBUTION_VERSION,
      plugin_manifest: '.codex-plugin/plugin.json',
      mcp_manifest: '.mcp.json',
      mcp_server_key: 'kneekura_code_lab',
      mcp_entrypoint: 'mcp/server.mjs',
      skill_entrypoint: 'skills/kneekura-code-lab/SKILL.md',
      deterministic_zip: true,
      desktop_local_mcp: true,
      contains_analysis_engine_implementation: true,
      contains_pinned_upstream_payloads: false,
      embedded_production_host_bridge_backend: true,
      backend_required_for_execution: false,
      pinned_upstream_roots_required_for_external_engines: true,
      builder: {
        mcp_bundle: 'esbuild',
        esbuild_version: PLUGIN_ESBUILD_VERSION,
        node_target: 'node20'
      },
      files: manifestFiles
    };
    const manifestBytes = Buffer.from(stableJson(manifest), 'utf8');
    entries.push({ path: 'plugin-distribution.json', data: manifestBytes });

    const zip = createDeterministicZip(entries, { root: 'kneekura-code-lab' });
    const zipDigest = `sha256:${sha256(zip)}`;
    const result = Object.freeze({
      schema: PLUGIN_DISTRIBUTION_SCHEMA,
      outputRoot: output,
      directory: path.join(output, 'kneekura-code-lab'),
      zipPath: path.join(output, 'kneekura-code-lab-plugin-v1.zip'),
      zipDigest,
      zipBytes: zip.length,
      mcpBundleDigest: `sha256:${sha256(mcpBundle)}`,
      manifest: deepFreeze(structuredClone(manifest))
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
        `${zipDigest.slice('sha256:'.length)}  ${path.basename(result.zipPath)}\n`,
        'utf8'
      );
    }

    return result;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function bundleMcpServer({ repositoryRoot, tempRoot }) {
  const outfile = path.join(tempRoot, 'server.mjs');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'exec',
    '--yes',
    '--package', `esbuild@${PLUGIN_ESBUILD_VERSION}`,
    '--',
    'esbuild',
    'mcp/src/server.mjs',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--tree-shaking=true',
    '--legal-comments=none',
    '--charset=utf8',
    '--log-level=warning',
    `--outfile=${outfile}`
  ];
  const run = childProcess.spawnSync(npm, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32'
  });
  if (run.error) {
    throw codedError('PLUGIN_MCP_BUNDLE_FAILED', run.error.message);
  }
  if (run.status !== 0) {
    throw codedError(
      'PLUGIN_MCP_BUNDLE_FAILED',
      `esbuild failed (${run.status}): ${bounded(run.stderr || run.stdout, 8192)}`
    );
  }
  return fs.readFile(outfile);
}

function fileRecord(target, source, data) {
  return {
    path: target,
    source,
    bytes: data.length,
    sha256: `sha256:${sha256(data)}`
  };
}

function normalizeTextBytes(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
}

function safeJoin(root, relative) {
  const normalized = String(relative ?? '').replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`unsafe plugin distribution path: ${relative}`);
  }
  const destination = path.resolve(root, ...normalized.split('/'));
  const prefix = path.resolve(root) + path.sep;
  if (!destination.startsWith(prefix)) {
    throw new TypeError(`plugin distribution path escapes root: ${relative}`);
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

function bounded(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[TRUNCATED]`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildKneekuraCodeLabPluginDistribution();
  process.stdout.write(stableJson({
    schema: result.schema,
    directory: result.directory,
    zip_path: result.zipPath,
    zip_digest: result.zipDigest,
    zip_bytes: result.zipBytes,
    mcp_bundle_digest: result.mcpBundleDigest,
    file_count: result.manifest.files.length + 1
  }));
}