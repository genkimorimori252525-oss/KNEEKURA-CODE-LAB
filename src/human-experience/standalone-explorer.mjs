import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, gzipSync } from 'node:zlib';

import {
  validateHumanExperienceProjection
} from './schema.mjs';

export const HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA =
  'kneekura.human-explorer-standalone-shell/v1';
export const HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA =
  'kneekura.human-experience-offline-payload/v1';
export const HUMAN_EXPERIENCE_GZIP_ENVELOPE_SCHEMA =
  'kneekura.human-experience-offline-envelope/v1';
export const HUMAN_EXPERIENCE_GZIP_ENCODING =
  'GZIP_BASE64_JSON';
export const HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER =
  '__KNEEKURA_HUMAN_EXPERIENCE_BASE64_V1__';
export const HUMAN_EXPLORER_TITLE_PLACEHOLDER =
  '__KNEEKURA_HUMAN_EXPLORER_TITLE_V1__';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src blob:";
const GZIP_WRITE_BATCH_CHARS = 16 * 1024;

export async function buildStandaloneHumanExplorerShell() {
  const prebuilt = await readAdjacentPrebuiltHumanExplorerShell();
  if (prebuilt) return prebuilt;

  let viteBuild;
  try {
    ({ build: viteBuild } = await import('vite'));
  } catch (error) {
    throw new TypeError(
      'standalone Human Explorer build requires the pinned Vite toolchain: ' +
      String(error?.message ?? error)
    );
  }

  const configFile = fileURLToPath(
    new URL(
      '../../packages/human-explorer/vite.config.mjs',
      import.meta.url
    )
  );
  const result = await viteBuild({
    configFile,
    logLevel: 'silent',
    build: {
      write: false,
      cssCodeSplit: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          codeSplitting: false,
          entryFileNames: 'assets/human-explorer.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]'
        }
      }
    }
  });

  const outputs = normalizeBuildOutputs(result);
  const chunks = outputs
    .filter(item => item.type === 'chunk')
    .sort((a, b) => compareText(a.fileName, b.fileName));
  if (chunks.length !== 1) {
    throw new TypeError(
      `standalone Human Explorer must emit exactly one JS chunk; received ${chunks.length}`
    );
  }
  const cssAssets = outputs
    .filter(item =>
      item.type === 'asset' &&
      String(item.fileName).endsWith('.css')
    )
    .sort((a, b) => compareText(a.fileName, b.fileName));
  const unsupportedAssets = outputs.filter(item =>
    item.type === 'asset' &&
    item.fileName !== 'index.html' &&
    !String(item.fileName).endsWith('.css')
  );
  if (unsupportedAssets.length) {
    throw new TypeError(
      'standalone Human Explorer externalized unsupported assets: ' +
      unsupportedAssets.map(item => item.fileName).sort().join(', ')
    );
  }

  const javascript = String(chunks[0].code ?? '');
  if (!javascript.trim()) {
    throw new TypeError(
      'standalone Human Explorer JS bundle is empty'
    );
  }
  const css = cssAssets
    .map(asset => assetText(asset))
    .join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(CSP)}">`,
    `<title>${HUMAN_EXPLORER_TITLE_PLACEHOLDER}</title>`,
    `<style>${escapeInlineStyle(css)}</style>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script id="kneekura-human-experience" type="application/octet-stream">${HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER}</script>`,
    `<script type="module">${escapeInlineScript(javascript)}</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n');

  assertStandaloneShellSafety(html);
  return deepFreeze({
    schema: HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA,
    renderer: 'HUMAN_EXPLORER_V2',
    csp: CSP,
    html,
    digest: digestBytes(html),
    javascript_digest: digestBytes(javascript),
    css_digest: digestBytes(css)
  });
}

export function injectHumanExperienceOfflinePayload(
  shell,
  {
    payload,
    title = 'KNEEKURA Human Explorer',
    compression = 'NONE'
  } = {}
) {
  assertOfflinePayloadInjection(shell, payload);
  const encoded = encodeOfflinePayload(payload, compression);
  return injectEncodedPayload(shell, encoded, title);
}

export async function injectHumanExperienceOfflinePayloadStreaming(
  shell,
  {
    payload,
    title = 'KNEEKURA Human Explorer'
  } = {}
) {
  assertOfflinePayloadInjection(shell, payload);
  const encoded = await encodeOfflinePayloadStreaming(payload);
  return injectEncodedPayload(shell, encoded, title);
}

function assertOfflinePayloadInjection(shell, payload) {
  if (
    !shell ||
    shell.schema !== HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA ||
    typeof shell.html !== 'string'
  ) {
    throw new TypeError(
      'offline payload injection requires a standalone Human Explorer shell'
    );
  }
  if (
    !payload ||
    payload.schema !== HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA
  ) {
    throw new TypeError(
      'offline payload must use ' + HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA
    );
  }
  validateHumanExperienceProjection(payload.experience);
  if (
    !payload.sources ||
    payload.sources.repository?.repository_id !==
      payload.experience.repository.repository_id ||
    payload.sources.repository?.snapshot_id !==
      payload.experience.repository.snapshot_id ||
    payload.sources.ir_digest !==
      payload.experience.source_identity.human_analysis_ir_digest
  ) {
    throw new TypeError(
      'offline source bundle identity does not match Human Experience'
    );
  }
  const payloadCount = countOccurrences(
    shell.html,
    HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER
  );
  const titleCount = countOccurrences(
    shell.html,
    HUMAN_EXPLORER_TITLE_PLACEHOLDER
  );
  if (payloadCount !== 1 || titleCount !== 1) {
    throw new TypeError(
      'standalone Human Explorer shell placeholders are invalid'
    );
  }
}

function injectEncodedPayload(shell, encoded, title) {
  const normalizedTitle = String(title ?? '').trim();
  if (!normalizedTitle) {
    throw new TypeError(
      'standalone Human Explorer title must not be empty'
    );
  }
  const html = shell.html
    .replace(HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER, encoded)
    .replace(
      HUMAN_EXPLORER_TITLE_PLACEHOLDER,
      escapeHtmlText(normalizedTitle.slice(0, 200))
    );
  if (
    html.includes(HUMAN_EXPERIENCE_PAYLOAD_PLACEHOLDER) ||
    html.includes(HUMAN_EXPLORER_TITLE_PLACEHOLDER)
  ) {
    throw new TypeError(
      'standalone Human Explorer payload injection was incomplete'
    );
  }
  assertStandaloneShellSafety(html);
  return html;
}

function encodeOfflinePayload(payload, compression) {
  const normalized = String(compression ?? 'NONE').toUpperCase();
  const payloadJson = stableJson(payload);
  if (normalized === 'NONE') {
    return Buffer.from(payloadJson, 'utf8').toString('base64');
  }
  if (normalized !== HUMAN_EXPERIENCE_GZIP_ENCODING) {
    throw new TypeError(`unsupported offline payload compression: ${compression}`);
  }
  const compressed = normalizeGzipHeader(
    gzipSync(Buffer.from(payloadJson, 'utf8'), { level: 9 })
  );
  return encodeCompressedEnvelope(compressed);
}

async function encodeOfflinePayloadStreaming(payload) {
  const compressed = normalizeGzipHeader(
    await gzipStableJson(payload)
  );
  return encodeCompressedEnvelope(compressed);
}

function encodeCompressedEnvelope(compressed) {
  const envelope = {
    schema: HUMAN_EXPERIENCE_GZIP_ENVELOPE_SCHEMA,
    encoding: HUMAN_EXPERIENCE_GZIP_ENCODING,
    payload_schema: HUMAN_EXPERIENCE_OFFLINE_PAYLOAD_SCHEMA,
    data: compressed.toString('base64')
  };
  return Buffer.from(stableJson(envelope), 'utf8').toString('base64');
}

async function gzipStableJson(value) {
  const gzip = createGzip({ level: 9 });
  const chunks = [];
  gzip.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const ended = once(gzip, 'end');
  let pending = '';

  const flushPending = async () => {
    if (!pending) return;
    const batch = pending;
    pending = '';
    if (!gzip.write(batch, 'utf8')) {
      await once(gzip, 'drain');
    }
  };

  for (const chunk of stableJsonChunks(value)) {
    let remaining = chunk;
    while (remaining.length > 0) {
      const capacity = GZIP_WRITE_BATCH_CHARS - pending.length;
      if (remaining.length <= capacity) {
        pending += remaining;
        break;
      }
      pending += remaining.slice(0, capacity);
      remaining = remaining.slice(capacity);
      await flushPending();
    }
  }
  await flushPending();
  gzip.end();
  await ended;
  return Buffer.concat(chunks);
}

function* stableJsonChunks(value, context = 'ROOT') {
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ',';
      const child = value[index];
      if (isJsonOmittedValue(child)) {
        yield 'null';
      } else {
        yield* stableJsonChunks(child, 'ARRAY');
      }
    }
    yield ']';
    return;
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const normalized = typeof value.toJSON === 'function'
      ? value.toJSON()
      : value;
    if (normalized !== value) {
      yield* stableJsonChunks(normalized, context);
      return;
    }
    yield '{';
    let first = true;
    for (const key of Object.keys(value).sort(compareText)) {
      const child = value[key];
      if (isJsonOmittedValue(child)) continue;
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key);
      yield ':';
      yield* stableJsonChunks(child, 'OBJECT');
    }
    yield '}';
    return;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    if (context === 'ARRAY') {
      yield 'null';
      return;
    }
    throw new TypeError('offline payload contains a non-JSON root/object value');
  }
  yield encoded;
}

function isJsonOmittedValue(value) {
  return value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol';
}

function normalizeGzipHeader(compressed) {
  if (compressed.length >= 10) {
    compressed.writeUInt32LE(0, 4);
    compressed[9] = 255;
  }
  return compressed;
}

async function readAdjacentPrebuiltHumanExplorerShell() {
  const url = new URL('./prebuilt-human-explorer-shell.json', import.meta.url);
  let raw;
  try {
    raw = await fs.readFile(url, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new TypeError(
      'prebuilt Human Explorer shell could not be read: ' +
      String(error?.message ?? error)
    );
  }
  let shell;
  try {
    shell = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      'prebuilt Human Explorer shell is not valid JSON: ' +
      String(error?.message ?? error)
    );
  }
  if (
    !shell ||
    shell.schema !== HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA ||
    shell.renderer !== 'HUMAN_EXPLORER_V2' ||
    typeof shell.html !== 'string' ||
    shell.digest !== digestBytes(shell.html)
  ) {
    throw new TypeError('prebuilt Human Explorer shell failed identity validation');
  }
  return deepFreeze(shell);
}

function normalizeBuildOutputs(result) {
  const results = Array.isArray(result) ? result : [result];
  const outputs = [];
  for (const item of results) {
    if (!item || !Array.isArray(item.output)) {
      throw new TypeError(
        'Vite standalone Human Explorer build did not return Rollup output'
      );
    }
    outputs.push(...item.output);
  }
  return outputs;
}

function assetText(asset) {
  const source = asset?.source;
  if (typeof source === 'string') return source;
  if (source instanceof Uint8Array) {
    return Buffer.from(source).toString('utf8');
  }
  throw new TypeError(
    `unsupported standalone Human Explorer asset source: ${asset?.fileName}`
  );
}

function assertStandaloneShellSafety(html) {
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    throw new TypeError(
      'standalone Human Explorer must not retain external script src'
    );
  }
  if (/<link\b[^>]*\bhref\s*=/i.test(html)) {
    throw new TypeError(
      'standalone Human Explorer must not retain external stylesheet href'
    );
  }
  if (!html.includes('Content-Security-Policy')) {
    throw new TypeError(
      'standalone Human Explorer CSP is required'
    );
  }
}

function stableJson(value) {
  const keys = new Set();
  collectJsonKeys(value, keys);
  return JSON.stringify(value, [...keys].sort(compareText));
}

function collectJsonKeys(value, keys) {
  if (Array.isArray(value)) {
    for (const child of value) collectJsonKeys(child, keys);
    return;
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    keys.add(key);
    collectJsonKeys(value[key], keys);
  }
}

function escapeInlineScript(value) {
  return String(value).replaceAll('</script', '<\\/script');
}

function escapeInlineStyle(value) {
  return String(value).replaceAll('</style', '<\\/style');
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function digestBytes(value) {
  return 'sha256:' +
    crypto.createHash('sha256')
      .update(Buffer.from(String(value), 'utf8'))
      .digest('hex');
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Buffer.isBuffer(value) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}