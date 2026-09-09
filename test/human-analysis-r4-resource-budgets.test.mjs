import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertExplorerLayoutBudget,
  buildElkLayoutInput,
  EXPLORER_LAYOUT_MAX_EDGES,
  EXPLORER_LAYOUT_MAX_NODES
} from '../src/presentation/explorer/layout.mjs';
import {
  assertHumanAnalysisSourcePayloadBudget,
  HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES,
  HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES,
  measureHumanAnalysisSourcePayload
} from '../src/human-analysis/index.mjs';

function uiModel(nodes, edges = []) {
  return {
    schema: 'kneekura.explorer-ui-model/v1',
    projection_schema: 'kneekura.explorer-projection/v1',
    source: {},
    nodes: Array.from({ length: nodes }, (_, index) => ({
      id: `node:${String(index).padStart(5, '0')}`,
      position: { x: 0, y: 0 },
      width: 240,
      height: 72,
      data: {}
    })),
    edges
  };
}

test('R4 ELK layout refuses an oversized scope instead of silently truncating canonical nodes', () => {
  const model = uiModel(EXPLORER_LAYOUT_MAX_NODES + 1);
  assert.throws(
    () => buildElkLayoutInput(model),
    error =>
      error?.code === 'EXPLORER_LAYOUT_BUDGET_EXCEEDED' &&
      /Narrow the Explorer hierarchy/.test(error.message)
  );
});

test('R4 ELK layout edge budget is explicit and fail-closed', () => {
  const model = uiModel(2);
  model.edges = Array.from(
    { length: EXPLORER_LAYOUT_MAX_EDGES + 1 },
    (_, index) => ({
      id: `edge:${index}`,
      source: 'node:00000',
      target: 'node:00001',
      data: {}
    })
  );
  assert.throws(
    () => assertExplorerLayoutBudget(model),
    error => error?.code === 'EXPLORER_LAYOUT_BUDGET_EXCEEDED'
  );
});

test('R4 source payload budgets measure UTF-8 bytes rather than character count', () => {
  const sources = [
    { ref: { kind: 'FILE_RANGE' }, text: 'あ'.repeat(10) },
    { ref: { kind: 'NODE' } }
  ];
  const measured = measureHumanAnalysisSourcePayload(sources);
  assert.equal(measured.source_records, 2);
  assert.equal(measured.text_records, 1);
  assert.equal(measured.total_text_bytes, 30);
  assert.equal(measured.max_record_text_bytes, 30);
});

test('R4 source payload refuses one oversized range without truncating source evidence', () => {
  const sources = [{
    ref: { kind: 'FILE_RANGE' },
    text: 'x'.repeat(HUMAN_SOURCE_MAX_RECORD_TEXT_BYTES + 1)
  }];
  assert.throws(
    () => assertHumanAnalysisSourcePayloadBudget(sources),
    error => error?.code === 'SOURCE_RECORD_TEXT_BUDGET_EXCEEDED'
  );
});

test('R4 source payload refuses an oversized total without dropping records', () => {
  const half = Math.floor(HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES / 2);
  const sources = [
    { ref: { kind: 'FILE_RANGE' }, text: 'a'.repeat(half) },
    { ref: { kind: 'FILE_RANGE' }, text: 'b'.repeat(half + 1) }
  ];
  assert.throws(
    () => assertHumanAnalysisSourcePayloadBudget(sources, {
      maxRecordTextBytes: HUMAN_SOURCE_MAX_TOTAL_TEXT_BYTES
    }),
    error => error?.code === 'SOURCE_TOTAL_TEXT_BUDGET_EXCEEDED'
  );
});