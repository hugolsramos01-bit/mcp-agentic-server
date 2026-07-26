/**
 * Structural diff helper for eval snapshots.
 *
 * Compares two JSON values and returns a list of differences.
 * Only structural/shape differences matter — text content is ignored
 * unless explicitly opted into.
 */

/**
 * @typedef {{ path: string; expected: any; actual: any; kind: 'missing_key' | 'type_change' | 'count_decreased' | 'value_mismatch' }} Diff
 */

/**
 * @param {any} expected
 * @param {any} actual
 * @param {string} path
 * @param {{ checkValues?: boolean }} [opts]
 * @returns {Diff[]}
 */
export function structuralDiff(expected, actual, path = "", opts = {}) {
  const diffs = [];

  if (expected === null || expected === undefined) return diffs;

  const expType = Array.isArray(expected) ? "array" : typeof expected;
  const actType = actual === null || actual === undefined
    ? "undefined"
    : Array.isArray(actual) ? "array" : typeof actual;

  if (expType !== actType) {
    diffs.push({ path, expected: expType, actual: actType, kind: "type_change" });
    return diffs;
  }

  if (expType === "array") {
    if (actual.length < expected.length) {
      diffs.push({
        path,
        expected: expected.length,
        actual: actual.length,
        kind: "count_decreased",
      });
    }
    // Check first item schema only (representative)
    if (expected.length > 0 && actual.length > 0) {
      diffs.push(...structuralDiff(expected[0], actual[0], `${path}[0]`, opts));
    }
    return diffs;
  }

  if (expType === "object") {
    for (const key of Object.keys(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual)) {
        diffs.push({ path: childPath, expected: typeof expected[key], actual: "undefined", kind: "missing_key" });
      } else {
        diffs.push(...structuralDiff(expected[key], actual[key], childPath, opts));
      }
    }
    return diffs;
  }

  // Primitive — only check if opted in
  if (opts.checkValues && expected !== actual) {
    diffs.push({ path, expected, actual, kind: "value_mismatch" });
  }

  return diffs;
}

/**
 * @param {Diff[]} diffs
 * @returns {string}
 */
export function formatDiffs(diffs) {
  if (diffs.length === 0) return "  (no structural differences)";
  return diffs.map((d) => {
    switch (d.kind) {
      case "missing_key":
        return `  ✗ MISSING KEY  ${d.path}  (expected ${d.expected})`;
      case "type_change":
        return `  ✗ TYPE CHANGE  ${d.path}  expected:${d.expected}  actual:${d.actual}`;
      case "count_decreased":
        return `  ✗ COUNT DROP   ${d.path}  expected>=${d.expected}  actual=${d.actual}`;
      case "value_mismatch":
        return `  ✗ VALUE        ${d.path}  expected:${JSON.stringify(d.expected)}  actual:${JSON.stringify(d.actual)}`;
      default:
        return `  ✗ ${d.path}`;
    }
  }).join("\n");
}
