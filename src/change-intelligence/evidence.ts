import { Confidence, EvidenceEntry } from "./types.js";

export function scoreConfidence(evidences: EvidenceEntry[]): Confidence {
  const types = new Set(evidences.map(e => e.type));
  
  if (
    types.has("focus_path") ||
    types.has("extracted_path")
  ) {
    return "high";
  } else if (
    types.size >= 2 &&
    (
      types.has("filename_exact") ||
      types.has("filename_partial") ||
      types.has("route") ||
      types.has("schema")
    )
  ) {
    return "high";
  } else if (types.has("content_match")) {
    return "medium";
  } else if (types.has("filename_partial") || types.has("test_proximity") || types.has("import")) {
    return "medium";
  } else if (types.size >= 2) {
    return "medium";
  }

  return "low";
}
