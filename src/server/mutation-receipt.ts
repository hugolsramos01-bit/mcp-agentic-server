import { stat, access } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { findNearbyTests } from "../change-intelligence/test-proximity.js";

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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function generateMutationReceipt(workspaceRoot: string, files: MutationReceiptInput[]): Promise<MutationReceipt | null> {
  if (files.length === 0) return null;

  let allFiles: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspaceRoot, timeout: 8000, maxBuffer: 10 * 1024 * 1024 }
    );
    allFiles = stdout.split("\n")
      .map(f => f.trim().replace(/\\/g, "/"))
      .filter(f => f.length > 0);
  } catch {}

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

    const relPath = absPath.startsWith(workspaceRoot) 
      ? absPath.substring(workspaceRoot.length + 1).replace(/\\/g, "/") 
      : file.path;
      
    const nearbyTestCandidates = findNearbyTests(relPath, allFiles);

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
