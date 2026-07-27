import { stat, readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../security/path-resolution.js";
import { assertPathOperationAllowed } from "../security/secret-policy.js";
import { CodeRegion } from "./types.js";
import { extractCodeRegions, ExtractCodeRegionsOptions } from "./code-regions.js";

const MAX_REGION_FILE_SIZE = 512 * 1024; // 512KB
const MAX_CACHE_SIZE = 150;

export interface CodeRegionCacheEntry {
  mtimeMs: number;
  size: number;
  regions: CodeRegion[];
}

const codeRegionCache = new Map<string, CodeRegionCacheEntry>();

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

export async function loadAndExtractCodeRegions(
  options: LoadCodeRegionsOptions
): Promise<{ path: string; codeRegions: CodeRegion[] }> {
  const { workspaceRoot, path, ...extractOptions } = options;

  const { canonicalPath } = resolveWorkspacePath(workspaceRoot, path, false);
  assertPathOperationAllowed(canonicalPath, "read");

  const stats = await stat(canonicalPath);

  if (stats.size > MAX_REGION_FILE_SIZE) {
    throw new CodeRegionSkippedError("file_too_large");
  }

  const cached = codeRegionCache.get(canonicalPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // refresh LRU
    codeRegionCache.delete(canonicalPath);
    codeRegionCache.set(canonicalPath, cached);
    return { path, codeRegions: cached.regions };
  }

  const content = await readFile(canonicalPath, "utf8");
  const regions = extractCodeRegions(canonicalPath, content, extractOptions);

  const newEntry: CodeRegionCacheEntry = {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    regions,
  };

  codeRegionCache.set(canonicalPath, newEntry);
  if (codeRegionCache.size > MAX_CACHE_SIZE) {
    const firstKey = codeRegionCache.keys().next().value;
    if (firstKey) {
      codeRegionCache.delete(firstKey);
    }
  }

  return { path, codeRegions: regions };
}

export function clearCodeRegionCache() {
  codeRegionCache.clear();
}
