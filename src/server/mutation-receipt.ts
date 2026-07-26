import { stat, access } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface MutationReceiptInput {
  path: string;
  operation: "add" | "update" | "delete" | "move";
  additions?: number;
  removals?: number;
  beforeHash?: string | null;
  afterHash?: string | null;
}

export interface MutationReceipt {
  version: 1;
  files: Array<{
    path: string;
    operation: "add" | "update" | "delete" | "move";
    additions: number;
    removals: number;
    beforeHash?: string | null;
    afterHash: string | null;
    nearbyTestCandidates: string[];
  }>;
  limitations: string[];
}

export async function computeHash(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch (e) {
    return null;
  }
}

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
  ];
  
  const found: string[] = [];
  for (const candidate of testCandidates) {
    try {
      await access(candidate);
      // Return relative path
      const relTest = candidate.startsWith(rootDir) 
        ? candidate.substring(rootDir.length + 1).replace(/\\\\/g, "/") 
        : candidate.replace(/\\\\/g, "/");
      found.push(relTest);
    } catch {
      // Ignore
    }
  }
  return found;
}

export async function generateMutationReceipt(workspaceRoot: string, files: MutationReceiptInput[]): Promise<MutationReceipt | null> {
  if (files.length === 0) return null;

  const receipt: MutationReceipt = {
    version: 1,
    files: [],
    limitations: ["Only same-directory test naming conventions were checked"]
  };

  for (const file of files) {
    const absPath = join(workspaceRoot, file.path);
    // Determine hash ensuring it follows the sha256: format if not already provided or if provided without prefix
    let afterHash = file.afterHash ?? await computeHash(absPath);
    if (afterHash && !afterHash.startsWith("sha256:")) {
      afterHash = `sha256:${afterHash}`;
    }
    
    let beforeHash = file.beforeHash;
    if (beforeHash && !beforeHash.startsWith("sha256:")) {
      beforeHash = `sha256:${beforeHash}`;
    }

    const nearbyTestCandidates = await findNearbyTests(absPath, workspaceRoot);

    receipt.files.push({
      path: file.path,
      operation: file.operation,
      additions: file.additions ?? 0,
      removals: file.removals ?? 0,
      beforeHash: beforeHash ?? null,
      afterHash: afterHash ?? null,
      nearbyTestCandidates
    });
  }
  return receipt;
}
