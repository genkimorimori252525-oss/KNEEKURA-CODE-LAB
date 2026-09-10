export function projectHostSemanticInput({ kind, payload, canonicalRepositoryIdentity } = {}) {
  const projected = structuredClone(payload);
  if (
    String(kind ?? '').startsWith('ua:') &&
    projected &&
    typeof projected === 'object' &&
    !Array.isArray(projected) &&
    typeof projected.projectRoot === 'string'
  ) {
    projected.projectRoot = String(canonicalRepositoryIdentity ?? '').trim();
  }
  return projected;
}
