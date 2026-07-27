import { Confidence, EvidenceEntry } from "./types.js";

/** Evidence types that signal direct relevance to the task goal. */
const RELEVANCE_TYPES = new Set([
  "focus_path", "extracted_path",
  "filename_exact", "filename_partial",
  "content_match", "route", "schema",
]);

/** Evidence types that only provide supporting context, not relevance. */
const SUPPORT_TYPES = new Set([
  "test_proximity", "import", "task_type",
]);

export function scoreConfidence(evidences: EvidenceEntry[]): Confidence {
  const types = new Set(evidences.map(e => e.type));
  
  // Directly specified paths → always high
  if (
    types.has("focus_path") ||
    types.has("extracted_path")
  ) {
    return "high";
  }

  // Count only RELEVANCE types for the "multiple signals → high" rule
  const relevanceCount = [...types].filter(t => RELEVANCE_TYPES.has(t)).length;
  const hasContentMatch = types.has("content_match");

  // Two or more distinct relevance signals → high (e.g. filename_exact + route)
  if (
    relevanceCount >= 2 &&
    (types.has("filename_exact") || types.has("filename_partial") || types.has("route") || types.has("schema"))
  ) {
    return "high";
  }

  // Single content match → medium
  if (hasContentMatch) {
    return "medium";
  }

  // Single filename/schema match → medium
  if (types.has("filename_partial") || types.has("route") || types.has("schema")) {
    return "medium";
  }

  // Support-only signals (test_proximity, import) → low unless combined
  if (types.has("test_proximity") || types.has("import")) {
    // Combined with at least one relevance type → medium
    if (relevanceCount >= 1) {
      return "medium";
    }
    return "low";
  }

  // Combined any 2 types → medium
  if (types.size >= 2) {
    return "medium";
  }

  return "low";
}
