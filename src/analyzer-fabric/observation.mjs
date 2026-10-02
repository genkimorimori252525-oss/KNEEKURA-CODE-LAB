import { createHash } from 'node:crypto';
import path from 'node:path';
import { FABRIC_CAPABILITIES } from './profile.mjs';

export const ANALYZER_OBSERVATION_SCHEMA = 'kneekura.analyzer-observation/v1';
const STRENGTHS = new Set(['EXACT', 'RESOLVED', 'STRUCTURAL', 'HEURISTIC', 'RUNTIME_OBSERVED']);
const COLUMN_UNITS = new Set(['UTF8_BYTES', 'UTF16_CODE_UNITS', 'UNICODE_CODE_POINTS']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function normalizeRepositoryPath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:\//.test(raw)) {
    throw new TypeError(`unsafe repository-relative path: ${value}`);
  }
  return normalized;
}

function digestText(text) {
  return `sha256:${sha256(Buffer.from(text, 'utf8'))}`;
}

function lineStartUtf16Indices(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineBounds(text, starts, lineIndex) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= starts.length) throw new RangeError(`line out of range: ${lineIndex}`);
  const start = starts[lineIndex];
  let end = lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : text.length;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  return [start, end];
}

function codePointBoundaryUtf16(line, units) {
  if (!Number.isInteger(units) || units < 0 || units > line.length) throw new RangeError(`UTF16 column out of range: ${units}`);
  if (units > 0 && units < line.length) {
    const prev = line.charCodeAt(units - 1);
    const next = line.charCodeAt(units);
    if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      throw new RangeError('UTF16 column splits a surrogate pair');
    }
  }
  return units;
}

function codePointUnitsToUtf16(line, units) {
  if (!Number.isInteger(units) || units < 0) throw new RangeError(`code-point column out of range: ${units}`);
  let utf16 = 0;
  let count = 0;
  for (const cp of line) {
    if (count === units) return utf16;
    utf16 += cp.length;
    count += 1;
  }
  if (count === units) return utf16;
  throw new RangeError(`code-point column out of range: ${units}`);
}

function utf8UnitsToUtf16(line, units) {
  if (!Number.isInteger(units) || units < 0) throw new RangeError(`UTF8 column out of range: ${units}`);
  if (units === 0) return 0;
  let bytes = 0;
  let utf16 = 0;
  for (const cp of line) {
    const next = bytes + Buffer.byteLength(cp, 'utf8');
    if (next === units) return utf16 + cp.length;
    if (next > units) throw new RangeError('UTF8 column is not on a code-point boundary');
    bytes = next;
    utf16 += cp.length;
  }
  if (bytes === units) return utf16;
  throw new RangeError(`UTF8 column out of range: ${units}`);
}

function positionToByteOffset(text, position, meta) {
  const starts = lineStartUtf16Indices(text);
  const lineBase = meta.line_base;
  const columnBase = meta.column_base;
  const lineIndex = Number(position.line) - lineBase;
  const columnUnits = Number(position.column) - columnBase;
  if (!Number.isInteger(columnUnits) || columnUnits < 0) throw new RangeError(`column out of range: ${position.column}`);
  const [lineStart, lineEnd] = lineBounds(text, starts, lineIndex);
  const line = text.slice(lineStart, lineEnd);
  let within;
  switch (meta.column_unit) {
    case 'UTF16_CODE_UNITS': within = codePointBoundaryUtf16(line, columnUnits); break;
    case 'UNICODE_CODE_POINTS': within = codePointUnitsToUtf16(line, columnUnits); break;
    case 'UTF8_BYTES': within = utf8UnitsToUtf16(line, columnUnits); break;
    default: throw new TypeError(`unsupported column unit ${meta.column_unit}`);
  }
  return Buffer.byteLength(text.slice(0, lineStart + within), 'utf8');
}

function presentationFromByteRange(text, startByte, endByte) {
  const buffer = Buffer.from(text, 'utf8');
  const beforeStart = buffer.subarray(0, startByte).toString('utf8');
  const beforeEnd = buffer.subarray(0, endByte).toString('utf8');
  return {
    start_line: beforeStart.split('\n').length,
    end_line: beforeEnd.split('\n').length
  };
}

function normalizeNativeMetadata(raw) {
  const source = raw.coordinate_system ?? raw.native_coordinates ?? raw;
  const line_base = Number(source.line_base);
  const column_base = Number(source.column_base);
  const column_unit = upper(source.column_unit);
  const end_semantics = upper(source.end_semantics);
  if (![0, 1].includes(line_base)) throw new TypeError('source range line_base must be 0 or 1');
  if (![0, 1].includes(column_base)) throw new TypeError('source range column_base must be 0 or 1');
  if (!COLUMN_UNITS.has(column_unit)) throw new TypeError(`unsupported source range column_unit ${column_unit}`);
  if (!['HALF_OPEN', 'INCLUSIVE'].includes(end_semantics)) throw new TypeError(`unsupported source range end_semantics ${end_semantics}`);
  return {
    provider_coordinate_system: String(source.provider_coordinate_system ?? 'DECLARED_LINE_COLUMN'),
    line_base,
    column_base,
    column_unit,
    end_semantics
  };
}

function isUtf8Boundary(text, byteOffset) {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) return false;
  let bytes = 0;
  if (byteOffset === 0) return true;
  for (const cp of text) {
    bytes += Buffer.byteLength(cp, 'utf8');
    if (bytes === byteOffset) return true;
    if (bytes > byteOffset) return false;
  }
  return bytes === byteOffset;
}

export function normalizeSourceRange(rawRange, { sourceText = null, expectedContentDigest = null } = {}) {
  if (rawRange == null) return null;
  if (!rawRange || typeof rawRange !== 'object') throw new TypeError('source_range must be an object');
  const sourceDigest = sourceText === null ? null : digestText(sourceText);

  if (Number.isInteger(rawRange.start_byte) && Number.isInteger(rawRange.end_byte)) {
    if (rawRange.start_byte < 0 || rawRange.end_byte < rawRange.start_byte) throw new RangeError('invalid byte range');
    const byte_unit = upper(rawRange.byte_unit || 'UTF8_BYTES');
    const byte_base = Number(rawRange.byte_base ?? 0);
    const end_semantics = upper(rawRange.end_semantics || rawRange.interval || 'HALF_OPEN');
    const native_coordinates = {
      provider_coordinate_system: String(rawRange.provider_coordinate_system ?? 'BYTE_OFFSETS'),
      start_byte: rawRange.start_byte,
      end_byte: rawRange.end_byte,
      byte_unit,
      byte_base,
      end_semantics
    };
    if (byte_unit !== 'UTF8_BYTES' || byte_base !== 0 || end_semantics !== 'HALF_OPEN') {
      return { native_coordinates };
    }
    const content_digest = String(rawRange.content_digest ?? expectedContentDigest ?? sourceDigest ?? '').trim();
    if (!content_digest) return { native_coordinates };
    if (sourceDigest && content_digest !== sourceDigest) throw new TypeError('source range content digest does not match supplied source text');
    if (expectedContentDigest && content_digest !== expectedContentDigest) throw new TypeError('source range content digest does not match expected digest');
    if (sourceText !== null) {
      const totalBytes = Buffer.byteLength(sourceText, 'utf8');
      if (rawRange.end_byte > totalBytes) throw new RangeError('byte range exceeds supplied source text');
      if (!isUtf8Boundary(sourceText, rawRange.start_byte) || !isUtf8Boundary(sourceText, rawRange.end_byte)) {
        throw new RangeError('byte range is not aligned to UTF-8 code-point boundaries');
      }
    }
    const result = {
      content_digest,
      start_byte: rawRange.start_byte,
      end_byte: rawRange.end_byte,
      byte_unit: 'UTF8_BYTES',
      byte_base: 0,
      interval: 'HALF_OPEN'
    };
    if (sourceText !== null) Object.assign(result, presentationFromByteRange(sourceText, rawRange.start_byte, rawRange.end_byte));
    return result;
  }

  const start = rawRange.start;
  const end = rawRange.end;
  if (!start || !end) return { native_coordinates: { ...rawRange } };
  const meta = normalizeNativeMetadata(rawRange);
  const native_coordinates = { ...meta, start: { ...start }, end: { ...end } };
  if (sourceText === null || meta.end_semantics !== 'HALF_OPEN') return { native_coordinates };

  const start_byte = positionToByteOffset(sourceText, start, meta);
  const end_byte = positionToByteOffset(sourceText, end, meta);
  if (end_byte < start_byte) throw new RangeError('source range end precedes start');
  const content_digest = String(rawRange.content_digest ?? expectedContentDigest ?? sourceDigest ?? '').trim();
  if (!content_digest) return { native_coordinates };
  if (sourceDigest && content_digest !== sourceDigest) throw new TypeError('source range content digest does not match supplied source text');
  if (expectedContentDigest && content_digest !== expectedContentDigest) throw new TypeError('source range content digest does not match expected digest');
  return {
    content_digest,
    start_byte,
    end_byte,
    byte_unit: 'UTF8_BYTES',
    byte_base: 0,
    interval: 'HALF_OPEN',
    start_line: Number(start.line) - meta.line_base + 1,
    end_line: Number(end.line) - meta.line_base + 1,
    native_coordinates
  };
}

function contextValue(raw, provenance, key, fallback = null) {
  const a = raw?.[key] ?? fallback;
  const b = provenance?.[key];
  if (a != null && b != null && String(a) !== String(b)) throw new TypeError(`provenance ${key} conflicts with observation context`);
  return a ?? b ?? null;
}

export function normalizeAnalyzerObservation(raw, {
  repositoryId = null,
  snapshotId = null,
  sourceTextByPath = {}
} = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('observation must be an object');
  const provider_id = String(raw.provider_id ?? '').trim();
  const provider_version = String(raw.provider_version ?? '').trim();
  const capability = upper(raw.capability);
  const strength = upper(raw.strength);
  const origin = upper(raw.origin);
  const observation_type = String(raw.observation_type ?? '').trim();
  if (!provider_id || !provider_version || !observation_type || !origin) throw new TypeError('observation is missing required provider/version/type/origin fields');
  if (!FABRIC_CAPABILITIES.includes(capability)) throw new TypeError(`unknown observation capability ${capability}`);
  if (!STRENGTHS.has(strength)) throw new TypeError(`unknown observation strength ${strength}`);
  if (!raw.subject || typeof raw.subject !== 'object') throw new TypeError('observation subject must be an object');
  if (!raw.provenance || typeof raw.provenance !== 'object') throw new TypeError('observation provenance must be an object');

  const provenance = { ...raw.provenance };
  const repository_id = contextValue(raw.snapshot ?? {}, provenance, 'repository_id', repositoryId);
  const snapshot_id = contextValue(raw.snapshot ?? {}, provenance, 'snapshot_id', snapshotId);
  if (!repository_id || !snapshot_id) throw new TypeError('observation snapshot requires repository_id and snapshot_id');
  if (provenance.provider_id && String(provenance.provider_id) !== provider_id) throw new TypeError('provenance provider_id conflicts with observation provider_id');
  if (provenance.provider_version && String(provenance.provider_version) !== provider_version) throw new TypeError('provenance provider_version conflicts with observation provider_version');

  const source_file = raw.source_file == null ? null : normalizeRepositoryPath(raw.source_file);
  if (source_file && provenance.path && normalizeRepositoryPath(provenance.path) !== source_file) throw new TypeError('provenance path conflicts with source_file');
  const sourceText = source_file ? (sourceTextByPath[source_file] ?? null) : null;
  const source_range = raw.source_range == null ? null : normalizeSourceRange(raw.source_range, { sourceText });

  const snapshot = { repository_id: String(repository_id), snapshot_id: String(snapshot_id) };
  const normalizedProvenance = {
    ...provenance,
    repository_id: snapshot.repository_id,
    snapshot_id: snapshot.snapshot_id,
    provider_id,
    provider_version
  };
  if (source_file) normalizedProvenance.path = source_file;

  const basis = {
    schema: ANALYZER_OBSERVATION_SCHEMA,
    provider_id,
    provider_version,
    snapshot,
    capability,
    observation_type,
    subject: structuredClone(raw.subject),
    strength,
    origin,
    provenance: normalizedProvenance,
    ...(source_file ? { source_file } : {}),
    ...(source_range ? { source_range } : {}),
    ...(raw.object !== undefined ? { object: structuredClone(raw.object) } : {}),
    ...(raw.raw_provider_ref !== undefined ? { raw_provider_ref: structuredClone(raw.raw_provider_ref) } : {}),
    ...(raw.provider_payload !== undefined ? { provider_payload: structuredClone(raw.provider_payload) } : {})
  };
  return {
    ...basis,
    id: `observation:${sha256(stable(basis)).slice(0, 32)}`
  };
}
