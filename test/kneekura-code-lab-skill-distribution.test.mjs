import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SKILL_DISTRIBUTION_FILES,
  SKILL_DISTRIBUTION_SCHEMA,
  buildKneekuraCodeLabSkillDistribution
} from '../scripts/build-kneekura-code-lab-skill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

test('Skill distribution is deterministic and contains only the explicit thin allowlist plus manifest', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kneekura-skill-dist-test-'));
  try {
    const firstRoot = path.join(temp, 'first');
    const secondRoot = path.join(temp, 'second');
    const first = await buildKneekuraCodeLabSkillDistribution({
      repositoryRoot: ROOT,
      outputRoot: firstRoot
    });
    const second = await buildKneekuraCodeLabSkillDistribution({
      repositoryRoot: ROOT,
      outputRoot: secondRoot
    });

    assert.equal(first.schema, SKILL_DISTRIBUTION_SCHEMA);
    assert.equal(first.zipDigest, second.zipDigest);
    assert.equal(first.zipBytes, second.zipBytes);
    assert.deepEqual(
      await fs.readFile(first.zipPath),
      await fs.readFile(second.zipPath)
    );

    const files = await listRelativeFiles(first.directory);
    const expected = [
      ...SKILL_DISTRIBUTION_FILES.map(row => row.target),
      'skill-distribution.json'
    ].sort();
    assert.deepEqual(files, expected);
    assert.equal(files.some(file => file.startsWith('src/')), false);
    assert.equal(files.some(file => file.includes('engine-lock.json')), false);

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(first.directory, 'skill-distribution.json'),
        'utf8'
      )
    );
    assert.equal(manifest.schema, SKILL_DISTRIBUTION_SCHEMA);
    assert.equal(manifest.entrypoint, 'SKILL.md');
    assert.equal(manifest.contains_engine_implementation, false);
    assert.equal(manifest.deterministic, true);
    assert.deepEqual(
      manifest.files.map(row => row.path).sort(),
      SKILL_DISTRIBUTION_FILES.map(row => row.target).sort()
    );
    assert.ok(
      manifest.files.every(row =>
        /^sha256:[0-9a-f]{64}$/.test(row.sha256) && row.bytes > 0
      )
    );

    const skill = await fs.readFile(path.join(first.directory, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: kneekura-code-lab\n/);
    assert.match(skill, /kneekura_code_lab_execute/);
    assert.match(skill, /no hidden default/i);

    const zipBytes = await fs.readFile(first.zipPath);
    assert.equal(zipBytes.includes(Buffer.from('src/skill/engines/', 'utf8')), false);
    assert.equal(zipBytes.includes(Buffer.from('KNEEKURA_CODE_LAB_MCP_BACKEND_MODULE', 'utf8')), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

async function listRelativeFiles(root) {
  const output = [];
  async function walk(current, relative = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else output.push(childRelative.replaceAll('\\', '/'));
    }
  }
  await walk(root);
  return output.sort();
}