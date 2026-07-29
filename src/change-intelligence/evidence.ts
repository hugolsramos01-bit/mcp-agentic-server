import { Confidence, EvidenceEntry, EvidenceType } from "./types.js";

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

export type KeywordStrength = "weak" | "normal" | "strong";

export const WEAK_GOAL_KEYWORDS = new Set([
  "admin", "app", "page", "web", "site", "data", "api", "route", "component", "src", "index"
]);

export const EVIDENCE_WEIGHTS = {
  focus_path: 100,
  extracted_path: 80,
  filename_exact: 45,
  schema: 40,
  content_match: 20,
  route: 10,
  filename_partial: 8,
  test_proximity: 5,
} as const;

export const KIND_PENALTIES = {
  source: 0,
  test: 5,
  configuration: 15,
  documentation: 30,
  snapshot: 50,
  evaluation: 60,
  generated: 100,
  unknown: 20,
} as const;

export function inferConfidence(evidence: readonly EvidenceEntry[]): Confidence {
  const has = (type: EvidenceType): boolean => evidence.some(item => item.type === type);

  if (has("focus_path") || has("extracted_path")) {
    return "high";
  }

  if (
    has("filename_exact") &&
    (
      has("content_match") ||
      has("route") ||
      has("schema")
    )
  ) {
    return "high";
  }
  if (
    has("schema") &&
    has("content_match")
  ) {
    return "high";
  }

  if (
    has("route") &&
    has("content_match")
  ) {
    return "medium";
  }

  return evidence.length > 0 ? "medium" : "low";
}
