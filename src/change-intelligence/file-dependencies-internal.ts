import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { Confidence } from "./types.js";

const execFileAsync = promisify(execFile);

export interface DirectDependentResult {
  source: string;
  dependents: string[];
  confidence: Confidence;
  limitations: string[];
}

/**
 * Perform a very fast, limited lookup of direct dependents using git grep.
 * This avoids a full AST parse of the workspace.
 */
export async function getLimitedSharedDependencies(cwd: string, targetPaths: string[]): Promise<DirectDependentResult[]> {
  const results: DirectDependentResult[] = [];
  
  if (targetPaths.length === 0) {
    return results;
  }
  
  for (const target of targetPaths) {
    const base = basename(target);
    const nameOnly = base.lastIndexOf(".") !== -1 ? base.substring(0, base.lastIndexOf(".")) : base;
    
    // We do a git grep for the base name. 
    // This is a heuristic and can yield false positives.
    if (nameOnly.length < 3) {
      results.push({
        source: target,
        dependents: [],
        confidence: "low",
        limitations: ["Filename too short for grep heuristics"]
      });
      continue;
    }

    try {
      const { stdout } = await execFileAsync("git", ["grep", "-l", nameOnly], {
        cwd,
        maxBuffer: 10 * 1024 * 1024
      });
      
      const lines = stdout.split("\n").map(l => l.trim()).filter(l => l && l !== target);
      // Let's limit the dependents to avoid overwhelming the context.
      const dependents = lines.slice(0, 10);
      const isTruncated = lines.length > 10;
      
      results.push({
        source: target,
        dependents,
        confidence: "medium", // Because it's purely lexical, there might be false positives
        limitations: [
          "Lexical search only (no AST)",
          ...(isTruncated ? [`Truncated to 10 files (found ${lines.length})`] : [])
        ]
      });
    } catch {
      // grep exits with 1 if no matches are found
      results.push({
        source: target,
        dependents: [],
        confidence: "high", // We confidently found nothing
        limitations: ["Lexical search only (no AST)"]
      });
    }
  }

  return results;
}
