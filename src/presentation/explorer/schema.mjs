export const EXPLORER_PROJECTION_SCHEMA =
  'kneekura.explorer-projection/v1';

export const EXPLORER_DISPLAY_FAMILIES = Object.freeze([
  'source',
  'forge',
  'network',
  'semantic',
  'runtime',
  'external',
  'canonical'
]);

// Presentation-only labels. They are never canonical node kinds.
export const SEMANTIC_DISPLAY_KINDS = Object.freeze([
  'molang_variable',
  'animation_name',
  'model_bone',
  'bone_name'
]);
