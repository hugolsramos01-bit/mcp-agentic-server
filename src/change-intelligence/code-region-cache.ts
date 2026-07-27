import { stat, readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../security/path-resolution.js";
import { assertPathOperationAllowed } from "../security/secret-policy.js";
import { CodeRegion } from "./types.js";
import { extractIndexedCodeRegions, ExtractCodeRegionsOptions, IndexedCodeRegion } from "./code-regions.js";

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
  rawRegions: IndexedCodeRegion[];
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

function cloneRegions(regions: IndexedCodeRegion[]): IndexedCodeRegion[] {
  return regions.map(r => {
    return {
      ...r,
      matchedKeywords: r.matchedKeywords ? [...r.matchedKeywords] : undefined,
    };
  });
}

// ─── Ranking helper ───────────────────────────────────────────────────
// Apply anchorKeyword scoring and maxRegions slicing to a raw region list.
// This mirrors extractCodeRegions() but operates on already-parsed data.

  function rankAndSlice(
    rawRegions: IndexedCodeRegion[],
    anchorKeywords: string[],
    maxRegions: number | undefined,
  ): CodeRegion[] {
    if (anchorKeywords.length === 0) {
      // No keywords — preserve source order and apply limit only
      const sliced = rawRegions.slice(0, maxRegions ?? rawRegions.length);
      return cloneRegions(sliced).map(r => {
        const { score, originalIndex, signature, body, isExported, ...rest } = r;
        return rest;
      });
    }
  
    const lowerKeywords = anchorKeywords.map(k => k.toLowerCase());
  
    interface Scored extends IndexedCodeRegion {
      _score: number;
      _idx: number;
    }
  
    const scored: Scored[] = rawRegions.map((ir, idx) => {
      const lowerName = ir.name.toLowerCase();
      const lowerQual = (ir.qualifiedName ?? "").toLowerCase();
      const lowerSig = (ir.signature ?? "").toLowerCase();
      const lowerBody = (ir.body ?? "").toLowerCase();
  
      let score = 0;
      const matchedKeywords: string[] = [];
  
      for (const kw of lowerKeywords) {
        let matched = false;
        if (lowerName === kw) { score += 100; matched = true; }
        else if (lowerName.includes(kw)) { score += 60; matched = true; }
        else if (lowerQual.includes(kw)) { score += 50; matched = true; }
        else if (lowerSig.includes(kw)) { score += 30; matched = true; }
        else if (lowerBody.includes(kw)) { score += 15; matched = true; }
  
        if (matched) matchedKeywords.push(kw);
      }
  
      if (ir.isExported) {
        score += 5;
      }
  
      return {
        ...ir,
        matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : ir.matchedKeywords,
        _score: score,
        _idx: idx,
      };
    });

  scored.sort((a, b) => {
    if (a._score !== b._score) return b._score - a._score;
    return a._idx - b._idx;
  });

  const limit = maxRegions ?? scored.length;
  return scored.slice(0, limit).map(({ _score, _idx, score, originalIndex, signature, body, isExported, ...rest }) => rest);
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
  let rawRegions: IndexedCodeRegion[];

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // LRU refresh
    codeRegionCache.delete(canonicalPath);
    codeRegionCache.set(canonicalPath, cached);
    rawRegions = cached.rawRegions;
  } else {
    // Cache miss: parse the file and store the unranked, uncut result
    const content = await readFile(canonicalPath, "utf8");
    // Extract without any keyword/maxRegions options so the raw index is neutral
    rawRegions = extractIndexedCodeRegions(canonicalPath, content, {});

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
