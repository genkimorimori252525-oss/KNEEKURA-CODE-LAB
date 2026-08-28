import {
  EXPLORER_UI_MODEL_SCHEMA,
  assertExplorerUiModel
} from './ui-model.mjs';

export const EXPLORER_LAYOUT_SCHEMA =
  'kneekura.explorer-layout/v1';

export const ELK_LAYOUT_OPTIONS = Object.freeze({
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '36',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.considerModelOrder.strategy':
    'NODES_AND_EDGES'
});

export function buildElkLayoutInput(model) {
  assertExplorerUiModel(model);

  const children = [...model.nodes]
    .sort((a, b) => compareText(a.id, b.id))
    .map(node => ({
      id: node.id,
      width: positiveNumber(node.width, 240),
      height: positiveNumber(node.height, 72)
    }));

  const edges = [...model.edges]
    .sort((a, b) => compareText(a.id, b.id))
    .map(edge => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    }));

  return {
    id: 'kneekura-explorer-root',
    layoutOptions: { ...ELK_LAYOUT_OPTIONS },
    children,
    edges
  };
}

export async function layoutExplorerUiModel(model, elk) {
  assertExplorerUiModel(model);
  if (!elk || typeof elk.layout !== 'function') {
    throw new TypeError(
      'Explorer layout requires an ELK-compatible engine'
    );
  }

  const layoutInput = buildElkLayoutInput(model);
  const result = await elk.layout(
    structuredClone(layoutInput)
  );
  return applyElkLayout(model, result);
}

export function applyElkLayout(model, layoutResult) {
  assertExplorerUiModel(model);

  if (
    !layoutResult ||
    !Array.isArray(layoutResult.children)
  ) {
    throw new TypeError(
      'Explorer layout result requires children'
    );
  }

  const positions = new Map();
  for (const child of layoutResult.children) {
    const id = requireString(child?.id, 'layout child id');
    if (positions.has(id)) {
      throw new TypeError(
        'Explorer layout node IDs must be unique: ' + id
      );
    }
    positions.set(id, {
      x: finiteNumber(child.x, 'layout x for ' + id),
      y: finiteNumber(child.y, 'layout y for ' + id)
    });
  }

  const modelIds = new Set(
    model.nodes.map(node => node.id)
  );
  if (
    positions.size !== modelIds.size ||
    [...positions.keys()].some(id => !modelIds.has(id))
  ) {
    throw new TypeError(
      'Explorer layout result must map every canonical UI node exactly once'
    );
  }

  const nodes = model.nodes.map(node => ({
    ...structuredClone(node),
    position: positions.get(node.id)
  }));

  return {
    schema: EXPLORER_LAYOUT_SCHEMA,
    engine: 'ELK',
    source_model_schema: EXPLORER_UI_MODEL_SCHEMA,
    nodes,
    edges: model.edges.map(edge =>
      structuredClone(edge)
    )
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? number
    : fallback;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(label + ' must be finite');
  }
  return number;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      label + ' must be a non-empty string'
    );
  }
  return value;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
