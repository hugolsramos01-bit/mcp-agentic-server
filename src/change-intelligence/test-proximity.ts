import { join, dirname, basename } from "node:path";
import { access } from "node:fs/promises";
export function findNearbyTests(filePath: string, allTrackedFiles: readonly string[]): string[] {
  // Normalize filePath to forward slashes just in case
  const normPath = filePath.replace(/\\/g, "/");
  const dir = dirname(normPath).replace(/\\/g, "/");
  const base = basename(normPath);
  
  // Strip extension
  const extIndex = base.lastIndexOf(".");
  const nameOnly = extIndex !== -1 ? base.substring(0, extIndex) : base;
  
  const testCandidates = [
    dir === "." ? `${nameOnly}.test.ts` : `${dir}/${nameOnly}.test.ts`,
    dir === "." ? `${nameOnly}.test.js` : `${dir}/${nameOnly}.test.js`,
    dir === "." ? `${nameOnly}.spec.ts` : `${dir}/${nameOnly}.spec.ts`,
    dir === "." ? `${nameOnly}.spec.js` : `${dir}/${nameOnly}.spec.js`,
    dir === "." ? `__tests__/${nameOnly}.test.ts` : `${dir}/__tests__/${nameOnly}.test.ts`,
    dir === "." ? `__tests__/${nameOnly}.test.js` : `${dir}/__tests__/${nameOnly}.test.js`,
    dir === "." ? `__tests__/${nameOnly}.spec.ts` : `${dir}/__tests__/${nameOnly}.spec.ts`,
    dir === "." ? `__tests__/${nameOnly}.spec.js` : `${dir}/__tests__/${nameOnly}.spec.js`,
  ];
  
  const found: string[] = [];
  for (const candidate of testCandidates) {
    if (allTrackedFiles.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}
