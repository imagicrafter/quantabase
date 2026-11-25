/**
 * Small pure helpers for read-merge-write against an API whose PUT replaces
 * the whole object: decide whether a write is needed at all, and build the
 * body that keeps everything already there.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export type JsonObject = { readonly [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when everything `wanted` asks for is already in `actual`. Objects may
 * hold extra keys; lists must match item for item, in order.
 */
export function contains(actual: unknown, wanted: Json): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, i) => contains(actual[i], item as Json))
    );
  }
  if (isObject(wanted)) {
    return (
      isObject(actual) &&
      Object.entries(wanted).every(([key, value]) =>
        contains(actual[key], value),
      )
    );
  }
  return actual === wanted;
}

/** `base` with `over` laid on top. Objects merge key by key; lists are replaced. */
export function mergeDeep(base: JsonObject, over: JsonObject): JsonObject {
  const merged = Object.entries(over).map(([key, value]) => {
    const current = base[key];
    return [
      key,
      isObject(current) && isObject(value) ? mergeDeep(current, value) : value,
    ] as const;
  });
  return { ...base, ...Object.fromEntries(merged) };
}

/** A copy without the named keys (the ones the API sets itself). */
export function without(
  object: JsonObject,
  keys: readonly string[],
): JsonObject {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !keys.includes(key)),
  );
}

/** Same items, in any order. */
export function sameItems(a: unknown, b: readonly Json[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left = a.map((item) => JSON.stringify(item)).sort();
  const right = b.map((item) => JSON.stringify(item)).sort();
  return left.every((item, i) => item === right[i]);
}

/** A copy with only the named keys. */
export function only(object: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => keys.includes(key)),
  );
}

/**
 * True when a value switches something on: `true`, a non-empty string, a
 * non-zero number, or a list or object holding any such value. `false`,
 * null, "", [] and {} (and objects of only those) are "not set".
 */
export function isSet(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.some(isSet);
  if (isObject(value)) return Object.values(value).some(isSet);
  return true;
}
