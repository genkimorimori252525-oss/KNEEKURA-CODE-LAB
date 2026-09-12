import fs from 'node:fs/promises';
import path from 'node:path';

import { composeVerifiedAllChildResults } from '../src/github-relay/all-mode-composition.mjs';

const INPUT_SCHEMA = 'kneekura.code-lab.github-relay-all-compose-input/v1';
const OUTPUT_SCHEMA = 'kneekura.code-lab.github-relay-all-compose-result/v1';
const EXPECTED_FILES = Object.freeze([
  'child-result-manifest.json',
  'engine-receipt.json',
  'result.zip'
]);

const inputPath = path.resolve(requireEnv('KNEEKURA_RELAY_ALL_COMPOSE_INPUT'));
const outputPath = path.resolve(requireEnv('KNEEKURA_RELAY_ALL_COMPOSE_OUTPUT'));
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema !== INPUT_SCHEMA) {
  throw new TypeError(`compose input schema must be ${INPUT_SCHEMA}`);
}
if (!Array.isArray(input.children) || input.children.length !== 3) {
  throw new TypeError('compose input must contain exactly three child artifacts');
}

const childInputs = [];
for (const child of input.children) {
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new TypeError('compose child entry must be an object');
  }
  const artifactRoot = path.resolve(String(child.artifact_root ?? ''));
  const files = (await fs.readdir(artifactRoot)).sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    throw integrityError('child Actions artifact must contain exactly the three sealed transport files');
  }
  const [manifestText, receiptText, sealedBytes] = await Promise.all([
    fs.readFile(path.join(artifactRoot, 'child-result-manifest.json'), 'utf8'),
    fs.readFile(path.join(artifactRoot, 'engine-receipt.json'), 'utf8'),
    fs.readFile(path.join(artifactRoot, 'result.zip'))
  ]);
  childInputs.push({
    manifest: JSON.parse(manifestText),
    receipt: JSON.parse(receiptText),
    sealedBytes,
    expectedBinding: child.binding,
    expectedContextClaim: child.context_claim
  });
}

const composed = composeVerifiedAllChildResults({
  parentPlan: input.parent_plan,
  childInputs
});
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, composed.bundleZip);
const summary = {
  schema: OUTPUT_SCHEMA,
  run_id: composed.runId,
  status: composed.status,
  snapshot_id: composed.snapshotId,
  scope_digest: composed.scopeDigest,
  bundle_digest: composed.bundleZipDigest,
  bundle_bytes: composed.bundleZip.length,
  output_path: outputPath
};
process.stdout.write(`${JSON.stringify(summary)}\n`);

function requireEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integrityError(message) {
  const error = new Error(message);
  error.code = 'ALL_CHILD_ARTIFACT_INTEGRITY_MISMATCH';
  return error;
}