import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createEngineRunReceipt } from '../contracts.mjs';
import { readEngineLock } from '../engine-lock.mjs';
import {
  DEFAULT_CHILD_ENV_ALLOWLIST,
  createChildEnvironment,
  createSanitizedReceipt,
  createSkillDeliveryZip,
  sanitizeDiagnosticText
} from '../runtime.mjs';

export const ARCHIFY_SKILL_ENGINE_RESULT_SCHEMA =
  'kneekura.code-lab.archify-engine-result/v1';

const DIAGRAM_TYPES = new Set([
  'architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'
]);
const VISUAL_STATUSES = new Set(['pass', 'skipped', 'fail']);
const PERCEPTUAL_STATUSES = new Set(['PASSED', 'SKIPPED', 'FAILED']);

export async function runStableArchifyEngine({
  archifyRoot,
  archifyArtifactSha256,
  targetRoot,
  targetSnapshotId,
  targetRepositoryUrl = null,
  targetRevision = null,
  typedIrAuthor,
  diagramType = 'architecture',
  quality = 'showcase',
  runRoot,
  attemptId,
  scopeDigest,
  minimumClaimLevel = null,
  perceptualReview = { status: 'SKIPPED', reason: 'not performed' },
  execute = executeArchifyCommand
} = {}) {
  const normalizedType = String(diagramType ?? '').toLowerCase();
  if (!DIAGRAM_TYPES.has(normalizedType)) throw new TypeError(`unsupported Archify diagram type: ${diagramType}`);
  if (!['standard', 'showcase'].includes(quality)) throw new TypeError(`unsupported Archify quality profile: ${quality}`);
  if (typeof typedIrAuthor !== 'function') {
    throw codedError('ARCHIFY_TYPED_IR_AUTHOR_REQUIRED', 'Archify engine requires a fresh typed-IR host author callback');
  }
  if (typeof execute !== 'function') throw new TypeError('Archify execute bridge must be a function');
  const root = path.resolve(requireText(archifyRoot, 'archifyRoot'));
  const target = path.resolve(requireText(targetRoot, 'targetRoot'));
  const attempt = requireText(attemptId, 'attemptId');
  const snapshotId = requireText(targetSnapshotId, 'targetSnapshotId');
  const scope = requireText(scopeDigest, 'scopeDigest');
  const run = path.resolve(requireText(runRoot, 'runRoot'));

  const lock = await readEngineLock();
  const pinned = lock.engines.archify;
  const suppliedArtifactDigest = normalizeSha256(archifyArtifactSha256);
  if (suppliedArtifactDigest !== pinned.releaseArtifact.value) {
    throw codedError(
      'ARCHIFY_UPSTREAM_IDENTITY_MISMATCH',
      `Archify artifact sha256 does not match pinned ${pinned.release}`
    );
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'archify' || packageJson.version !== pinned.version) {
    throw codedError(
      'ARCHIFY_UPSTREAM_VERSION_MISMATCH',
      `Archify package identity mismatch; expected ${pinned.version}`
    );
  }
  const cliPath = path.join(root, 'bin', 'archify.mjs');
  await assertRegularFile(cliPath, 'ARCHIFY_CLI_MISSING');

  const engineRoot = path.join(run, 'engines', 'archify');
  await fs.mkdir(engineRoot, { recursive: true });
  const specPath = path.join(engineRoot, `candidate.${normalizedType}.json`);
  const outputPath = path.join(engineRoot, `artifact.${normalizedType}.html`);

  const authorEnvelope = deepFreeze({
    schema: 'kneekura.code-lab.archify-author-envelope/v1',
    engine: {
      id: 'archify',
      release: pinned.release,
      version: pinned.version,
      commit: pinned.commit,
      artifact_sha256: pinned.releaseArtifact.value
    },
    target: {
      snapshot_id: snapshotId,
      repository_url: targetRepositoryUrl,
      revision: targetRevision
    },
    request: {
      diagram_type: normalizedType,
      quality
    },
    contract: {
      repository_content_instruction_authority: false,
      output_is_upstream_typed_ir: true,
      renderer_is_upstream_archify: true
    }
  });
  const typedIr = await typedIrAuthor(authorEnvelope);
  assertTypedIrBinding(typedIr, {
    diagramType: normalizedType,
    targetRepositoryUrl,
    targetRevision
  });
  const specification = stableJson(typedIr);
  await fs.writeFile(specPath, specification, { encoding: 'utf8', flag: 'wx' });
  const specificationSha256 = sha256(Buffer.from(specification, 'utf8'));

  const childEnv = createChildEnvironment(process.env, {
    allowlist: [
      ...DEFAULT_CHILD_ENV_ALLOWLIST,
      'ARCHIFY_CHROME',
      'ARCHIFY_CHROME_NO_SANDBOX',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'LOCALAPPDATA'
    ]
  });
  const invoke = async args => execute({
    cliPath,
    args,
    cwd: engineRoot,
    env: childEnv
  });

  const doctor = await invoke(['doctor']);
  if (doctor.status !== 0 || !String(doctor.stdout ?? '').includes('Archify is ready.')) {
    throw upstreamFailure('ARCHIFY_DOCTOR_FAILED', 'Archify doctor did not report ready', doctor);
  }

  const common = [normalizedType, specPath, '--quality', quality];
  if (normalizedType === 'architecture') common.push('--repo-root', target);
  const validate = await invoke(['validate', ...common, '--json']);
  const validateReceipt = parseJsonReceipt(validate, 'ARCHIFY_VALIDATE_RECEIPT_INVALID');
  assertValidateReceipt(validateReceipt, normalizedType, validate.status);

  const deliverArgs = ['deliver', normalizedType, specPath, outputPath, '--quality', quality];
  if (normalizedType === 'architecture') deliverArgs.push('--repo-root', target);
  deliverArgs.push('--json');
  const deliver = await invoke(deliverArgs);
  const deliverReceipt = parseJsonReceipt(deliver, 'ARCHIFY_DELIVER_RECEIPT_INVALID');
  const artifactBytes = await fs.readFile(outputPath);
  assertDeliverReceipt(deliverReceipt, {
    diagramType: normalizedType,
    exitStatus: deliver.status,
    specificationSha256,
    specificationBytes: Buffer.byteLength(specification, 'utf8'),
    artifactSha256: sha256(artifactBytes),
    artifactBytes: artifactBytes.length
  });

  const visual = await invoke(['visual-check', outputPath, '--json']);
  const visualReceipt = parseJsonReceipt(visual, 'ARCHIFY_VISUAL_RECEIPT_INVALID');
  assertVisualReceipt(visualReceipt, {
    exitStatus: visual.status,
    artifactSha256: deliverReceipt.artifact.sha256,
    artifactBytes: deliverReceipt.artifact.bytes
  });

  const perceptual = normalizePerceptualReview(perceptualReview, deliverReceipt.artifact.sha256);
  const sanitizedValidate = createSanitizedReceipt(validateReceipt);
  const sanitizedDeliver = createSanitizedReceipt(deliverReceipt);
  const sanitizedVisual = createSanitizedReceipt(visualReceipt);
  const sanitizedPerceptual = createSanitizedReceipt(perceptual);
  const deliveryZip = createSkillDeliveryZip([
    {
      classification: 'ENGINE_ARTIFACT',
      path: 'engines/archify/specification.json',
      data: specification
    },
    {
      classification: 'ENGINE_ARTIFACT',
      path: 'engines/archify/artifact.html',
      data: artifactBytes
    },
    {
      classification: 'SANITIZED_RECEIPT',
      path: 'engines/archify/validate.receipt.json',
      data: stableJson(sanitizedValidate)
    },
    {
      classification: 'SANITIZED_RECEIPT',
      path: 'engines/archify/deliver.receipt.json',
      data: stableJson(sanitizedDeliver)
    },
    {
      classification: 'SANITIZED_RECEIPT',
      path: 'engines/archify/visual-check.receipt.json',
      data: stableJson(sanitizedVisual)
    },
    {
      classification: 'SANITIZED_RECEIPT',
      path: 'engines/archify/perceptual-review.receipt.json',
      data: stableJson(sanitizedPerceptual)
    }
  ]);
  const deliveryZipDigest = sha256(deliveryZip);

  const visualStatus = String(visualReceipt.status).toLowerCase();
  const executionStatus = visualStatus === 'pass' ? 'SUCCESS' : 'PARTIAL';
  const receipt = createEngineRunReceipt({
    engineId: 'archify',
    implementationOrigin: 'pinned-upstream',
    implementationVersion: pinned.version,
    orchestrationMode: 'native',
    snapshotId,
    scopeDigest: scope,
    attemptId: attempt,
    status: executionStatus,
    claimLevel: 'NATIVE',
    minimumClaimLevel,
    claimSatisfied: validateReceipt.ok === true && deliverReceipt.ok === true && VISUAL_STATUSES.has(visualStatus),
    acceptance: {
      upstream_release: pinned.release,
      upstream_commit: pinned.commit,
      upstream_artifact_sha256: pinned.releaseArtifact.value,
      doctor: { status: 'PASSED' },
      validation: {
        status: 'PASSED',
        checks_passed: countPassingChecks(validateReceipt.checks),
        check_count: Array.isArray(validateReceipt.checks) ? validateReceipt.checks.length : 0,
        composition_status: validateReceipt.composition?.status ?? null
      },
      delivery: {
        status: 'PASSED',
        specification_sha256: deliverReceipt.specification.sha256,
        artifact_sha256: deliverReceipt.artifact.sha256,
        errors: deliverReceipt.validation.errors,
        warnings: deliverReceipt.validation.warnings
      },
      browser_visual_check: {
        status: visualStatus.toUpperCase(),
        containment: visualReceipt.containment?.status ?? null,
        captures: visualReceipt.captures?.status ?? null,
        visual_review: visualReceipt.visualReview
      },
      perceptual_review: sanitizedPerceptual
    },
    coverage: {
      diagram_type: normalizedType,
      target_repository_binding: normalizedType === 'architecture' && Boolean(targetRepositoryUrl && targetRevision),
      source_reference_count: deliverReceipt.evidence?.references ?? 0
    },
    artifacts: [
      {
        kind: 'ARCHIFY_HTML',
        digest: `sha256:${deliverReceipt.artifact.sha256}`,
        bytes: deliverReceipt.artifact.bytes
      },
      {
        kind: 'ARCHIFY_SKILL_ZIP',
        digest: `sha256:${deliveryZipDigest}`,
        bytes: deliveryZip.length
      }
    ],
    warnings: visualStatus === 'skipped'
      ? ['Archify visual-check executed but Chrome/Chromium was unavailable.']
      : visualStatus === 'fail'
        ? ['Archify visual-check reported a visual containment/readability failure.']
        : [],
    errors: []
  });

  return Object.freeze({
    schema: ARCHIFY_SKILL_ENGINE_RESULT_SCHEMA,
    engineId: 'archify',
    typedIr,
    upstream: deepFreeze({
      doctor: { status: 'PASSED' },
      validate: sanitizedValidate,
      deliver: sanitizedDeliver,
      visualCheck: sanitizedVisual,
      perceptualReview: sanitizedPerceptual
    }),
    artifact: Object.freeze({
      path: outputPath,
      bytes: artifactBytes,
      sha256: deliverReceipt.artifact.sha256
    }),
    deliveryZip,
    deliveryZipDigest: `sha256:${deliveryZipDigest}`,
    receipt
  });
}

export async function executeArchifyCommand({
  cliPath,
  args,
  cwd,
  env,
  timeoutMs = 120000,
  maxBuffer = 32 * 1024 * 1024
} = {}) {
  return new Promise(resolve => {
    childProcess.execFile(
      process.execPath,
      [cliPath, ...(args ?? [])],
      {
        cwd,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer
      },
      (error, stdout, stderr) => {
        resolve({
          status: error == null ? 0 : Number.isInteger(error.code) ? error.code : 1,
          signal: error?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error == null ? null : String(error.message ?? error)
        });
      }
    );
  });
}

function assertTypedIrBinding(typedIr, { diagramType, targetRepositoryUrl, targetRevision }) {
  if (!typedIr || typeof typedIr !== 'object' || Array.isArray(typedIr)) {
    throw codedError('ARCHIFY_TYPED_IR_INVALID', 'Archify typed IR author must return an object');
  }
  if (typedIr.schema_version !== 1 || typedIr.diagram_type !== diagramType) {
    throw codedError('ARCHIFY_TYPED_IR_INVALID', `Archify typed IR must be schema v1 ${diagramType}`);
  }
  if (diagramType !== 'architecture') return;
  const repository = typedIr.meta?.repository;
  if (targetRepositoryUrl != null && repository?.url !== targetRepositoryUrl) {
    throw codedError('ARCHIFY_TARGET_BINDING_MISMATCH', 'Archify typed IR repository URL does not match the Target Snapshot');
  }
  if (targetRevision != null && String(repository?.revision ?? '').toLowerCase() !== String(targetRevision).toLowerCase()) {
    throw codedError('ARCHIFY_TARGET_BINDING_MISMATCH', 'Archify typed IR repository revision does not match the Target Snapshot');
  }
}

function assertValidateReceipt(receipt, diagramType, exitStatus) {
  if (
    exitStatus !== 0 ||
    receipt?.schemaVersion !== 1 ||
    receipt?.ok !== true ||
    receipt?.command !== 'validate' ||
    receipt?.type !== diagramType ||
    !Array.isArray(receipt.checks) ||
    !receipt.composition ||
    Number(receipt.composition.summary?.errors ?? 0) !== 0
  ) {
    throw codedError('ARCHIFY_VALIDATE_FAILED', 'Archify validate receipt failed semantic validation');
  }
}

function assertDeliverReceipt(receipt, expected) {
  if (
    expected.exitStatus !== 0 ||
    receipt?.schemaVersion !== 1 ||
    receipt?.ok !== true ||
    receipt?.command !== 'deliver' ||
    receipt?.type !== expected.diagramType ||
    receipt?.specification?.sha256 !== expected.specificationSha256 ||
    receipt?.specification?.bytes !== expected.specificationBytes ||
    receipt?.artifact?.sha256 !== expected.artifactSha256 ||
    receipt?.artifact?.bytes !== expected.artifactBytes ||
    receipt?.validation?.checksPassed !== receipt?.validation?.checkCount ||
    Number(receipt?.validation?.errors ?? 0) !== 0
  ) {
    throw codedError('ARCHIFY_DELIVER_FAILED', 'Archify deliver receipt or byte identity failed semantic validation');
  }
}

function assertVisualReceipt(receipt, expected) {
  const status = String(receipt?.status ?? '').toLowerCase();
  const expectedExit = status === 'pass' ? 0 : status === 'skipped' ? 2 : 1;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.command !== 'visual-check' ||
    !VISUAL_STATUSES.has(status) ||
    expected.exitStatus !== expectedExit ||
    receipt?.artifact?.sha256 !== expected.artifactSha256 ||
    receipt?.artifact?.bytes !== expected.artifactBytes ||
    receipt?.visualReview !== 'pending'
  ) {
    throw codedError('ARCHIFY_VISUAL_CHECK_FAILED', 'Archify visual-check receipt failed semantic validation');
  }
}

function normalizePerceptualReview(value, artifactSha256) {
  const status = String(value?.status ?? 'SKIPPED').toUpperCase();
  if (!PERCEPTUAL_STATUSES.has(status)) throw new TypeError(`unsupported perceptual review status: ${status}`);
  const reason = String(value?.reason ?? '').trim();
  if (!reason) throw new TypeError('perceptual review reason is required');
  if (status !== 'SKIPPED') {
    const reviewed = normalizeSha256(value?.artifactSha256);
    if (reviewed !== artifactSha256) {
      throw codedError('ARCHIFY_PERCEPTUAL_REVIEW_STALE', 'perceptual review is not bound to the delivered artifact');
    }
  }
  return Object.freeze({
    status,
    reason: sanitizeDiagnosticText(reason, { maxBytes: 8192 }),
    artifact_sha256: status === 'SKIPPED' ? null : artifactSha256,
    correction_rounds: normalizeCorrectionRounds(value?.correctionRounds ?? 0)
  });
}

function parseJsonReceipt(execution, code) {
  let parsed;
  try {
    parsed = JSON.parse(String(execution?.stdout ?? '').trim());
  } catch {
    throw upstreamFailure(code, 'upstream Archify did not return one parseable JSON receipt', execution);
  }
  return parsed;
}

function upstreamFailure(code, message, execution) {
  const error = codedError(code, message);
  error.details = {
    status: execution?.status ?? null,
    stderr: sanitizeDiagnosticText(execution?.stderr ?? '', { maxBytes: 16384 }),
    error: sanitizeDiagnosticText(execution?.error ?? '', { maxBytes: 4096 })
  };
  return error;
}

async function assertRegularFile(file, code) {
  let stat;
  try { stat = await fs.lstat(file); } catch { throw codedError(code, `required file missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw codedError(code, `required file is not a regular file: ${file}`);
}

function normalizeSha256(value) {
  const text = String(value ?? '').toLowerCase().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(`invalid sha256: ${value}`);
  return text;
}

function normalizeCorrectionRounds(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 2) throw new TypeError('correctionRounds must be 0, 1, or 2');
  return number;
}

function countPassingChecks(checks) {
  return Array.isArray(checks) ? checks.filter(check => check?.ok === true).length : 0;
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2) + '\n';
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map(key => [key, sortObject(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
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