import { normalize } from "node:path";
import { IndexedPath, createIndexedPath } from "../change-intelligence/indexed-path.js";

export interface WorkspaceFileSnapshot {
  files: readonly string[];
  fileSet: ReadonlySet<string>;
  indexedPaths: readonly IndexedPath[];
  createdAt: number;
}

const CACHE_TTL_MS = 5000;
const cacheMap = new Map<string, WorkspaceFileSnapshot>();

export function getWorkspaceFileCacheKey(workspaceId: string, root: string): string {
  return `${workspaceId}:${normalize(root)}`;
}

export function getWorkspaceFileSnapshot(cacheKey: string): WorkspaceFileSnapshot | null {
  const snapshot = cacheMap.get(cacheKey);
  if (!snapshot) return null;
  if (Date.now() - snapshot.createdAt > CACHE_TTL_MS) {
    cacheMap.delete(cacheKey);
    return null;
  }
  return snapshot;
}

export function setWorkspaceFileSnapshot(cacheKey: string, files: readonly string[]): WorkspaceFileSnapshot {
  const indexedPaths = files.map(createIndexedPath);
  const snapshot: WorkspaceFileSnapshot = {
    files,
    fileSet: new Set(files),
    indexedPaths,
    createdAt: Date.now(),
  };
  cacheMap.set(cacheKey, snapshot);
  return snapshot;
}

export function invalidateWorkspaceFileSnapshot(workspaceId: string, root: string): void {
  const cacheKey = getWorkspaceFileCacheKey(workspaceId, root);
  cacheMap.delete(cacheKey);
}

export function clearWorkspaceFileCache(): void {
  cacheMap.clear();
}
