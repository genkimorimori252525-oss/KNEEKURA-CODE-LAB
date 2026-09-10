import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_DISTRIBUTION_SCHEMA,
  PLUGIN_ESBUILD_VERSION,
  buildKneekuraCodeLabPluginDistribution
} from '../scripts/build-kneekura-code-lab-plugin.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_MCP = Buffer.from([
  'export const fixture = true;',
  'export const toolNames = ["kneekura_code_lab_describe","kneekura_code_lab_plan","kneekura_code_lab_execute"];',
  ''
].join('\n'), 'utf8');

async function buildFixture() {
  return buildKneekuraCodeLabPluginDistribution({
    repositoryRoot: ROOT,
    write: false,
    async bundleMcp() {
      return Buffer.from(FAKE_MCP);
    }
  });
}

test('Plugin v1 distribution is deterministic and rooted at one plugin directory', async () => {
  const first = await buildFixture();
  const second = await buildFixture();

  assert.equal(first.schema, PLUGIN_DISTRIBUTION_SCHEMA);
  assert.equal(first.zipDigest, second.zipDigest);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.mcpBundleDigest, `sha256:${sha256(FAKE_MCP)}`);

  const firstZip = await buildZipFixture();
  const secondZip = await buildZipFixture();
  assert.deepEqual(firstZip.zip, secondZip.zip);
  assert.equal(firstZip.digest, secondZip.digest);
  assert.equal(firstZip.entries.every(entry => entry.name.startsWith('kneekura-code-lab/')), true);
});

test('Plugin v1 archive contains only the explicit native plugin surface', async () => {
  const fixture = await buildZipFixture();
  const names = fixture.entries.map(entry => entry.name);
  assert.deepEqual(names, [
    'kneekura-code-lab/.codex-plugin/plugin.json',
    'kneekura-code-lab/.mcp.json',
    'kneekura-code-lab/README.md',
    'kneekura-code-lab/mcp/server.mjs',
    'kneekura-code-lab/plugin-distribution.json',
    'kneekura-code-lab/skills/kneekura-code-lab/SKILL.md',
    'kneekura-code-lab/skills/kneekura-code-lab/references/INSTALL.md',
    'kneekura-code-lab/skills/kneekura-code-lab/references/MCP.md'
  ]);

  const forbidden = [
    'node_modules/', '.git/', 'src/skill/engines/', 'fixtures/',
    'target-repository/', '.env', 'stdout.log', 'stderr.log'
  ];
  for (const needle of forbidden) {
    assert.equal(names.some(name => name.includes(needle)), false, needle);
  }
  assert.deepEqual(fixture.file('mcp/server.mjs'), FAKE_MCP);
});

test('native plugin manifest and MCP declaration use portable current paths', async () => {
  const fixture = await buildZipFixture();
  const plugin = JSON.parse(fixture.text('.codex-plugin/plugin.json'));
  const mcp = JSON.parse(fixture.text('.mcp.json'));

  assert.equal(plugin.name, 'kneekura-code-lab');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.skills, './skills/');
  assert.equal(plugin.mcpServers, './.mcp.json');
  assert.ok(plugin.interface.capabilities.includes('Read'));
  assert.ok(plugin.interface.capabilities.includes('Interactive'));

  assert.deepEqual(Object.keys(mcp.mcpServers), ['kneekura_code_lab']);
  assert.equal(Object.keys(mcp.mcpServers)[0].includes('-'), false);
  assert.deepEqual(mcp.mcpServers.kneekura_code_lab, {
    command: 'node',
    args: ['./mcp/server.mjs'],
    cwd: '.'
  });
  assert.equal(path.isAbsolute(mcp.mcpServers.kneekura_code_lab.args[0]), false);
  assert.equal(path.isAbsolute(mcp.mcpServers.kneekura_code_lab.cwd), false);
});

test('plugin distribution manifest binds every payload by hash and records fail-closed runtime facts', async () => {
  const fixture = await buildZipFixture();
  const manifest = JSON.parse(fixture.text('plugin-distribution.json'));

  assert.equal(manifest.schema, PLUGIN_DISTRIBUTION_SCHEMA);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.mcp_server_key, 'kneekura_code_lab');
  assert.equal(manifest.mcp_entrypoint, 'mcp/server.mjs');
  assert.equal(manifest.skill_entrypoint, 'skills/kneekura-code-lab/SKILL.md');
  assert.equal(manifest.deterministic_zip, true);
  assert.equal(manifest.desktop_local_mcp, true);
  assert.equal(manifest.contains_analysis_engine_implementation, false);
  assert.equal(manifest.backend_required_for_execution, true);
  assert.equal(manifest.builder.esbuild_version, PLUGIN_ESBUILD_VERSION);
  assert.equal(manifest.builder.node_target, 'node20');

  for (const record of manifest.files) {
    const data = fixture.file(record.path);
    assert.equal(record.bytes, data.length, record.path);
    assert.equal(record.sha256, `sha256:${sha256(data)}`, record.path);
  }
});

test('packaged Skill and README preserve the no-fake-execution and untrusted-target boundaries', async () => {
  const fixture = await buildZipFixture();
  const skill = fixture.text('skills/kneekura-code-lab/SKILL.md');
  const readme = fixture.text('README.md');

  assert.match(skill, /Do not label ordinary model reasoning as an engine run/);
  assert.match(skill, /untrusted data/);
  assert.match(skill, /Do not execute target builds, tests, package installers, hooks, scripts or binaries/);
  assert.match(readme, /fails closed/);
  assert.match(readme, /does not invent an execution backend/);
});

async function buildZipFixture() {
  let captured = null;
  const result = await buildKneekuraCodeLabPluginDistribution({
    repositoryRoot: ROOT,
    write: false,
    async bundleMcp() {
      return Buffer.from(FAKE_MCP);
    }
  });

  // Reconstruct exactly from the returned manifest and canonical source inputs.
  // The production packager itself is exercised again with write=true in a
  // throwaway output by CI; unit tests avoid network/esbuild by injecting the bundle.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-plugin-test-'));
  try {
    const written = await buildKneekuraCodeLabPluginDistribution({
      repositoryRoot: ROOT,
      outputRoot: tmp,
      write: true,
      async bundleMcp() {
        return Buffer.from(FAKE_MCP);
      }
    });
    const zip = await fs.readFile(written.zipPath);
    const entries = readStoredZip(zip);
    captured = {
      zip,
      digest: written.zipDigest,
      entries,
      file(relative) {
        const name = `kneekura-code-lab/${relative}`;
        const entry = entries.find(row => row.name === name);
        assert.ok(entry, `missing ZIP entry: ${relative}`);
        return Buffer.from(entry.data);
      },
      text(relative) {
        return this.file(relative).toString('utf8');
      }
    };
    assert.equal(result.zipDigest, written.zipDigest);
    return captured;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function readStoredZip(buffer) {
  const entries = [];
  let offset = 0;
  while (
    offset + 30 <= buffer.length &&
    buffer.readUInt32LE(offset) === 0x04034b50
  ) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    assert.equal(method, 0, 'test parser only accepts STORE entries');
    assert.ok(dataStart + size <= buffer.length, 'ZIP entry exceeds archive');
    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      data: Buffer.from(buffer.subarray(dataStart, dataStart + size))
    });
    offset = dataStart + size;
  }
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  return entries;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}