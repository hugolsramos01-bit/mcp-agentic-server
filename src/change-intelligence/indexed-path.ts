import { basename, dirname } from "node:path";

export interface IndexedPath {
  path: string;
  base: string;
  dir: string;
  nameOnly: string;
}

export function createIndexedPath(path: string): IndexedPath {
  const base = basename(path);
  const dir = dirname(path);
  const dotIndex = base.lastIndexOf(".");
  const nameOnly = dotIndex !== -1 ? base.substring(0, dotIndex).toLowerCase() : base.toLowerCase();
  return { path, base, dir, nameOnly };
}
