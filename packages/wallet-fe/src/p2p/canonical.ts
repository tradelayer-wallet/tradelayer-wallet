function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function canonicalizeValue(v: any): any {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(canonicalizeValue);
  if (isPlainObject(v)) {
    const out: Record<string, any> = {};
    const keys = Object.keys(v).sort();
    for (const k of keys) out[k] = canonicalizeValue(v[k]);
    return out;
  }
  return v;
}

// Deterministic, key-sorted JSON stringification for hashing/signing.
export function stableStringify(v: unknown): string {
  return JSON.stringify(canonicalizeValue(v));
}

