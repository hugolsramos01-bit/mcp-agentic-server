import { join, dirname, basename } from "node:path";
import { access } from "node:fs/promises";

export async function findNearbyTests(filePath: string, rootDir: string): Promise<string[]> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  
  // Strip extension
  const extIndex = base.lastIndexOf(".");
  const nameOnly = extIndex !== -1 ? base.substring(0, extIndex) : base;
  
  const testCandidates = [
    join(dir, `${nameOnly}.test.ts`),
    join(dir, `${nameOnly}.test.js`),
    join(dir, `${nameOnly}.spec.ts`),
    join(dir, `${nameOnly}.spec.js`),
    join(dir, "__tests__", `${nameOnly}.test.ts`),
    join(dir, "__tests__", `${nameOnly}.test.js`),
    join(dir, "__tests__", `${nameOnly}.spec.ts`),
    join(dir, "__tests__", `${nameOnly}.spec.js`),
  ];
  
  const found: string[] = [];
  for (const candidate of testCandidates) {
    try {
      await access(candidate);
      // Return relative path
      const relTest = candidate.startsWith(rootDir) 
        ? candidate.substring(rootDir.length + 1).replace(/\\/g, "/") 
        : candidate.replace(/\\/g, "/");
      found.push(relTest);
    } catch {
      // Ignore
    }
  }
  return found;
}
