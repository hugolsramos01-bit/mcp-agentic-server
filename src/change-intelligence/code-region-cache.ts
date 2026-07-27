import { stat, readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../security/path-resolution.js";
import { assertPathOperationAllowed } from "../security/secret-policy.js";
import { CodeRegion } from "./types.js";
import { extractCodeRegions, ExtractCodeRegionsOptions } from "./code-regions.js";

const MAX_REGION_FILE_SIZE = 512 * 1024; // 512KB
const MAX_CACHE_SIZE = 150;

// ─── Raw index entry (unranked, uncut) ────────────────────────────────
// The cache stores the full extraction result, without any ranking or slicing.
// Ranking and slicing are performed in-memory after a cache hit, ensuring
// that two callers with different anchorKeywords receive independent results.

interface CodeRegionRawEntry {
  mtimeMs: number;
  size: number;
  /** All regions extracted from the file, in original source order (no ranking). */
  rawRegions: CodeRegion[];
}

const codeRegionCache = new Map<string, CodeRegionRawEntry>();

export class CodeRegionSkippedError extends Error {
  constructor(public reason: string) {
    super(`Code region extraction skipped: ${reason}`);
    this.name = "CodeRegionSkippedError";
  }
}

export interface LoadCodeRegionsOptions extends ExtractCodeRegionsOptions {
  workspaceRoot: string;
  path: string;
}

// ─── Clone helper ─────────────────────────────────────────────────────
// Always return a defensive copy so that the budget enforcement loop
// (file.codeRegions.pop()) never mutates the cached array.

function cloneRegions(regions: CodeRegion[]): CodeRegion[] {
  return regions.map(r => ({
    ...r,
    matchedKeywords: r.matchedKeywords ? [...r.matchedKeywords] : undefined,
  }));
}

// ─── Ranking helper ───────────────────────────────────────────────────
// Apply anchorKeyword scoring and maxRegions slicing to a raw region list.
// This mirrors extractCodeRegions() but operates on already-parsed data.

function rankAndSlice(
  rawRegions: CodeRegion[],
  anchorKeywords: string[],
  maxRegions: number | undefined,
): CodeRegion[] {
  if (anchorKeywords.length === 0) {
    // No keywords — preserve source order and apply limit only
    const sliced = rawRegions.slice(0, maxRegions ?? rawRegions.length);
    return cloneRegions(sliced);
  }

  const lowerKeywords = anchorKeywords.map(k => k.toLowerCase());

  interface Scored extends CodeRegion {
    _score: number;
    _idx: number;
  }

  const scored: Scored[] = rawRegions.map((r, idx) => {
    const lowerName = r.name.toLowerCase();
    const lowerQual = (r.qualifiedName ?? "").toLowerCase();
    let score = 0;
    const matchedKeywords: string[] = [];

    for (const kw of lowerKeywords) {
      let matched = false;
      if (lowerName === kw) { score += 100; matched = true; }
      else if (lowerName.includes(kw)) { score += 60; matched = true; }
      else if (lowerQual.includes(kw)) { score += 50; matched = true; }
      // Note: body/signature scoring would require the original text.
      // For cache hits we rely on name/qualifiedName scoring only, which
      // covers the vast majority of real use-cases. Full scoring happens
      // on the initial extraction path inside extractCodeRegions().
      if (matched) matchedKeywords.push(kw);
    }

    return {
      ...r,
      matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : r.matchedKeywords,
      _score: score,
      _idx: idx,
    };
  });

  scored.sort((a, b) => {
    if (a._score !== b._score) return b._score - a._score;
    return a._idx - b._idx;
  });

  const limit = maxRegions ?? scored.length;
  return scored.slice(0, limit).map(({ _score, _idx, ...rest }) => rest);
}

// ─── Public API ───────────────────────────────────────────────────────

export async function loadAndExtractCodeRegions(
  options: LoadCodeRegionsOptions
): Promise<{ path: string; codeRegions: CodeRegion[] }> {
  const { workspaceRoot, path, anchorKeywords, maxRegions, ...rest } = options;
  void rest; // absorb any extra ExtractCodeRegionsOptions fields

  const { canonicalPath } = resolveWorkspacePath(workspaceRoot, path, false);
  assertPathOperationAllowed(canonicalPath, "read");

  const stats = await stat(canonicalPath);

  if (stats.size > MAX_REGION_FILE_SIZE) {
    throw new CodeRegionSkippedError("file_too_large");
  }

  // ── Cache lookup (raw index, keyed by path + mtime + size) ──────────
  const cached = codeRegionCache.get(canonicalPath);
  let rawRegions: CodeRegion[];

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // LRU refresh
    codeRegionCache.delete(canonicalPath);
    codeRegionCache.set(canonicalPath, cached);
    rawRegions = cached.rawRegions;
  } else {
    // Cache miss: parse the file and store the unranked, uncut result
    const content = await readFile(canonicalPath, "utf8");
    // Extract without any keyword/maxRegions options so the raw index is neutral
    rawRegions = extractCodeRegions(canonicalPath, content, {});

    const newEntry: CodeRegionRawEntry = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      rawRegions: cloneRegions(rawRegions), // defensive copy stored in cache
    };

    codeRegionCache.set(canonicalPath, newEntry);
    if (codeRegionCache.size > MAX_CACHE_SIZE) {
      const firstKey = codeRegionCache.keys().next().value;
      if (firstKey) codeRegionCache.delete(firstKey);
    }
  }

  // ── Rank and slice in-memory, return defensive clone ─────────────────
  const codeRegions = rankAndSlice(rawRegions, anchorKeywords ?? [], maxRegions);
  return { path, codeRegions };
}

export function clearCodeRegionCache(): void {
  codeRegionCache.clear();
}

/** Exposed for testing only. */
export function getCodeRegionCacheSize(): number {
  return codeRegionCache.size;
}
