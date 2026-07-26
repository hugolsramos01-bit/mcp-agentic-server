/**
 * Typed assertion helpers for eval cases.
 */

/**
 * Assert that value has a specific JSON schema shape.
 * Throws with a descriptive message on failure.
 *
 * @param {string} label
 * @param {any} value
 * @param {{ [key: string]: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any' }} shape
 */
export function assertShape(label, value, shape) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label}: expected object, got ${typeof value}`);
  }
  for (const [key, expectedType] of Object.entries(shape)) {
    if (!(key in value)) {
      throw new Error(`${label}: missing required field "${key}"`);
    }
    if (expectedType === "any") continue;
    if (expectedType === "array") {
      if (!Array.isArray(value[key])) {
        throw new Error(`${label}.${key}: expected array, got ${typeof value[key]}`);
      }
    } else if (typeof value[key] !== expectedType) {
      throw new Error(`${label}.${key}: expected ${expectedType}, got ${typeof value[key]}`);
    }
  }
}

/**
 * Assert that an array has at least minLength items.
 *
 * @param {string} label
 * @param {any[]} arr
 * @param {number} minLength
 */
export function assertMinLength(label, arr, minLength) {
  if (!Array.isArray(arr)) throw new Error(`${label}: expected array`);
  if (arr.length < minLength) {
    throw new Error(`${label}: expected at least ${minLength} items, got ${arr.length}`);
  }
}

/**
 * Assert that value is not null/undefined and optionally passes a predicate.
 *
 * @param {string} label
 * @param {any} value
 * @param {((v: any) => boolean) | undefined} [predicate]
 */
export function assertPresent(label, value, predicate) {
  if (value === null || value === undefined) {
    throw new Error(`${label}: expected value, got ${value}`);
  }
  if (predicate && !predicate(value)) {
    throw new Error(`${label}: value failed predicate: ${JSON.stringify(value)}`);
  }
}
