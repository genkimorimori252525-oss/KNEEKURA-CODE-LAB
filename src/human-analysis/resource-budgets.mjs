export const HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES = 1024 * 1024;
export const HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;

export function measureHumanAnalysisSourcePayload(sources = []) {
  if (!Array.isArray(sources)) {
    throw new TypeError('source payload must be an array');
  }
  let totalTextBytes = 0;
  let textRecords = 0;
  let maxRecordTextBytes = 0;
  const records = sources.map((source, index) => {
    if (!source || typeof source !== 'object') {
      throw new TypeError(`source payload record is invalid: ${index}`);
    }
    const textBytes = typeof source.text === 'string'
      ? Buffer.byteLength(source.text, 'utf8')
      : 0;
    if (textBytes > 0) {
      textRecords += 1;
      totalTextBytes += textBytes;
      maxRecordTextBytes = Math.max(maxRecordTextBytes, textBytes);
    }
    return {
      index,
      kind: String(source.ref?.kind ?? 'UNKNOWN').toUpperCase(),
      text_bytes: textBytes
    };
  });
  return Object.freeze({
    source_records: sources.length,
    text_records: textRecords,
    total_text_bytes: totalTextBytes,
    max_record_text_bytes: maxRecordTextBytes,
    records: Object.freeze(records.map(row => Object.freeze(row)))
  });
}

export function assertHumanAnalysisSourcePayloadBudget(
  sources,
  {
    maxRecordTextBytes = HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES,
    maxTotalTextBytes = HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES
  } = {}
) {
  for (const [label, value] of [
    ['maxRecordTextBytes', maxRecordTextBytes],
    ['maxTotalTextBytes', maxTotalTextBytes]
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative integer`);
    }
  }
  const measurement = measureHumanAnalysisSourcePayload(sources);
  const oversized = measurement.records.find(
    row => row.text_bytes > maxRecordTextBytes
  );
  if (oversized) {
    const error = new RangeError(
      `source payload record exceeds byte budget: ` +
      `${oversized.text_bytes}/${maxRecordTextBytes} bytes at index ${oversized.index}`
    );
    error.code = 'SOURCE_RECORD_TEXT_BUDGET_EXCEEDED';
    error.details = Object.freeze({
      index: oversized.index,
      bytes: oversized.text_bytes,
      max_bytes: maxRecordTextBytes
    });
    throw error;
  }
  if (measurement.total_text_bytes > maxTotalTextBytes) {
    const error = new RangeError(
      'source payload total text exceeds byte budget: ' +
      `${measurement.total_text_bytes}/${maxTotalTextBytes} bytes`
    );
    error.code = 'SOURCE_TOTAL_TEXT_BUDGET_EXCEEDED';
    error.details = Object.freeze({
      bytes: measurement.total_text_bytes,
      max_bytes: maxTotalTextBytes
    });
    throw error;
  }
  return measurement;
}