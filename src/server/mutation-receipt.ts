import { stat, access } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface MutationReceiptInput {
  path: string;
  operation: "update" | "add" | "delete" | "move";
  additions?: number;
  removals?: number;
  afterHash?: string | null;
}

export async function computeHash(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
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
      found.push(candidate);
    } catch {
      // Ignore
    }
  }
  return found;
}

export async function formatMutationReceipt(workspaceRoot: string, files: MutationReceiptInput[]): Promise<string> {
  if (files.length === 0) return "";

  let receipt = "\n\n### Mutation Receipt\n";
  for (const file of files) {
    const absPath = join(workspaceRoot, file.path);
    const hash = file.afterHash ?? await computeHash(absPath);
    
    receipt += `- **${file.path}** (${file.operation})\n`;
    if (hash) {
      receipt += `  - Hash: \`${hash}\`\n`;
    }
    if (file.additions !== undefined && file.removals !== undefined) {
      receipt += `  - Changes: +${file.additions}, -${file.removals}\n`;
    }
    
    const nearbyTests = await findNearbyTests(absPath, workspaceRoot);
    if (nearbyTests.length > 0) {
      receipt += `  - Nearest Tests:\n`;
      for (const test of nearbyTests) {
        // Convert absPath back to relative
        const relTest = test.startsWith(workspaceRoot) ? test.substring(workspaceRoot.length + 1).replace(/\\/g, "/") : test.replace(/\\/g, "/");
        receipt += `    - \`${relTest}\` (Run with: \`npm run test -- ${relTest}\`)\n`;
      }
    }
  }
  return receipt;
}
