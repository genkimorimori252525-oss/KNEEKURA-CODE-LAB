import {
  assertExplorerUiModel
} from './ui-model.mjs';
import {
  EXPLORER_PROJECTION_SCHEMA
} from './schema.mjs';

export const EXPLORER_GUIDED_TOUR_SCHEMA =
  'kneekura.explorer-guided-tour/v1';

export function createExplorerGuidedTour(
  projection,
  model
) {
  assertProjectionShape(projection);
  assertExplorerUiModel(model);

  const canonicalNodes = uniqueMap(
    projection.canonical.graph.nodes,
    item => item.id,
    'Canonical node'
  );
  const presentationNodes = uniqueMap(
    projection.presentation.nodes,
    item => item.node_id,
    'Presentation node'
  );
  const uiNodes = uniqueMap(
    model.nodes,
    item => item.id,
    'Explorer UI node'
  );
  const presentationEdges = uniqueMap(
    projection.presentation.edges,
    item => item.edge_id,
    'Presentation edge'
  );
  const uiEdges = uniqueMap(
    model.edges,
    item => item.id,
    'Explorer UI edge'
  );

  const tourNodes =
    projection.canonical.graph.nodes.filter(
      node => node.kind === 'ua:tour_step'
    );

  for (const edge of projection.canonical.graph.edges) {
    if (edge.type !== 'UA_TOUR_HIGHLIGHTS') continue;
    const source = canonicalNodes.get(edge.from);
    if (!source || source.kind !== 'ua:tour_step') {
      throw new TypeError(
        'Guided tour highlight source is not a tour step: ' +
        String(edge.id)
      );
    }
  }

  const steps = tourNodes.map(node => {
    const presentationNode =
      presentationNodes.get(node.id);
    const uiNode = uiNodes.get(node.id);
    if (
      !presentationNode ||
      presentationNode.canonical_kind !==
        'ua:tour_step' ||
      presentationNode.node_id !== node.id ||
      uiNode?.data?.canonical_node_id !== node.id ||
      uiNode?.data?.canonical_kind !==
        'ua:tour_step'
    ) {
      throw new TypeError(
        'Guided tour step trace mismatch: ' +
        String(node.id)
      );
    }

    const highlightEdges =
      projection.canonical.graph.edges
        .map((edge, canonicalIndex) => ({
          edge,
          canonicalIndex
        }))
        .filter(
          item =>
            item.edge.from === node.id &&
            item.edge.type ===
              'UA_TOUR_HIGHLIGHTS'
        )
        .sort(
          (a, b) =>
            a.canonicalIndex - b.canonicalIndex
        );

    const highlightNodeIds = [];
    const highlightEdgeIds = [];
    const seenTargets = new Set();

    for (const { edge } of highlightEdges) {
      const target = canonicalNodes.get(edge.to);
      const presentationEdge =
        presentationEdges.get(edge.id);
      const uiEdge = uiEdges.get(edge.id);

      if (!target) {
        throw new TypeError(
          'Guided tour highlight target is foreign: ' +
          String(edge.to)
        );
      }
      if (
        !presentationEdge ||
        presentationEdge.from_node_id !==
          edge.from ||
        presentationEdge.to_node_id !==
          edge.to ||
        presentationEdge.canonical_type !==
          edge.type ||
        uiEdge?.source !== edge.from ||
        uiEdge?.target !== edge.to ||
        uiEdge?.data?.canonical_edge_id !==
          edge.id ||
        uiEdge?.data?.canonical_type !==
          edge.type
      ) {
        throw new TypeError(
          'Guided tour highlight edge trace mismatch: ' +
          String(edge.id)
        );
      }
      if (seenTargets.has(edge.to)) {
        throw new TypeError(
          'Guided tour highlight target is duplicated: ' +
          String(edge.to)
        );
      }
      seenTargets.add(edge.to);
      highlightNodeIds.push(edge.to);
      highlightEdgeIds.push(edge.id);
    }

    return {
      step_node_id: node.id,
      order:
        typeof node.order === 'number' &&
        Number.isFinite(node.order)
          ? node.order
          : null,
      label:
        typeof node.label === 'string'
          ? node.label
          : node.id,
      description:
        typeof node.description === 'string'
          ? node.description
          : null,
      language_lesson:
        typeof node.languageLesson === 'string'
          ? node.languageLesson
          : null,
      highlight_node_ids: highlightNodeIds,
      highlight_edge_ids: highlightEdgeIds,
      focus_node_id:
        highlightNodeIds[0] ?? null
    };
  });

  steps.sort(compareSteps);

  return {
    schema: EXPLORER_GUIDED_TOUR_SCHEMA,
    projection_schema: projection.schema,
    model_schema: model.schema,
    source: structuredClone(projection.source ?? null),
    has_tour: steps.length > 0,
    step_count: steps.length,
    steps
  };
}

export function createGuidedTourPlayback(
  tour,
  index = null
) {
  assertGuidedTour(tour);
  if (index == null || tour.steps.length === 0) {
    return {
      active: false,
      index: null,
      step_node_id: null
    };
  }
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= tour.steps.length
  ) {
    throw new RangeError(
      'Guided tour playback index is out of range'
    );
  }
  return {
    active: true,
    index,
    step_node_id: tour.steps[index].step_node_id
  };
}

export function startGuidedTour(tour) {
  assertGuidedTour(tour);
  return tour.steps.length === 0
    ? createGuidedTourPlayback(tour)
    : createGuidedTourPlayback(tour, 0);
}

export function moveGuidedTour(
  tour,
  playback,
  delta
) {
  assertGuidedTour(tour);
  assertPlayback(tour, playback);
  if (!playback.active) return playback;
  if (delta !== -1 && delta !== 1) {
    throw new TypeError(
      'Guided tour move delta must be -1 or 1'
    );
  }
  const next = Math.max(
    0,
    Math.min(
      tour.steps.length - 1,
      playback.index + delta
    )
  );
  return createGuidedTourPlayback(tour, next);
}

export function exitGuidedTour(tour) {
  return createGuidedTourPlayback(tour);
}

export function guidedTourCurrentStep(
  tour,
  playback
) {
  assertGuidedTour(tour);
  assertPlayback(tour, playback);
  return playback.active
    ? tour.steps[playback.index]
    : null;
}

function compareSteps(a, b) {
  const aNumbered = a.order != null;
  const bNumbered = b.order != null;
  if (aNumbered && bNumbered && a.order !== b.order) {
    return a.order - b.order;
  }
  if (aNumbered !== bNumbered) {
    return aNumbered ? -1 : 1;
  }
  return compareText(a.step_node_id, b.step_node_id);
}

function assertProjectionShape(projection) {
  if (
    !projection ||
    projection.schema !==
      EXPLORER_PROJECTION_SCHEMA ||
    !projection.canonical?.graph ||
    !Array.isArray(
      projection.canonical.graph.nodes
    ) ||
    !Array.isArray(
      projection.canonical.graph.edges
    ) ||
    !projection.presentation ||
    !Array.isArray(projection.presentation.nodes) ||
    !Array.isArray(projection.presentation.edges)
  ) {
    throw new TypeError(
      'Guided tours require ' +
      EXPLORER_PROJECTION_SCHEMA
    );
  }
}

function assertGuidedTour(tour) {
  if (
    !tour ||
    tour.schema !== EXPLORER_GUIDED_TOUR_SCHEMA ||
    !Array.isArray(tour.steps) ||
    tour.step_count !== tour.steps.length
  ) {
    throw new TypeError(
      'Invalid Explorer guided tour model'
    );
  }
}

function assertPlayback(tour, playback) {
  if (
    !playback ||
    typeof playback.active !== 'boolean'
  ) {
    throw new TypeError(
      'Invalid guided tour playback state'
    );
  }
  if (!playback.active) {
    if (
      playback.index !== null ||
      playback.step_node_id !== null
    ) {
      throw new TypeError(
        'Inactive guided tour playback is inconsistent'
      );
    }
    return;
  }
  if (
    !Number.isInteger(playback.index) ||
    playback.index < 0 ||
    playback.index >= tour.steps.length ||
    tour.steps[playback.index].step_node_id !==
      playback.step_node_id
  ) {
    throw new TypeError(
      'Active guided tour playback is inconsistent'
    );
  }
}

function uniqueMap(items, keyFor, description) {
  const map = new Map();
  for (const item of items) {
    const key = String(keyFor(item));
    if (map.has(key)) {
      throw new TypeError(
        description + ' IDs must be unique: ' + key
      );
    }
    map.set(key, item);
  }
  return map;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
