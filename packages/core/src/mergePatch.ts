/**
 * JSON Merge Patch (RFC 7396): objects merge recursively, `null` deletes a
 * key, everything else (including arrays) replaces.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
