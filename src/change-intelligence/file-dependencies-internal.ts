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
 * Limited, fast lookup of direct dependents using git grep on the basename.
 * Lexical only — no AST. Caller must treat results as heuristic.
 * Limited to top 3 sources to avoid overwhelming the context.
 */
export async function getLimitedSharedDependencies(
  cwd: string,
  targetPaths: string[]
): Promise<DirectDependentResult[]> {
  const results: DirectDependentResult[] = [];

  // Hard cap: only analyze up to 3 primary files
  for (const target of targetPaths.slice(0, 3)) {
    const base = basename(target);
    const dotIdx = base.lastIndexOf(".");
    const nameOnly = dotIdx !== -1 ? base.substring(0, dotIdx) : base;

    if (nameOnly.length < 3) {
      results.push({
        source: target,
        dependents: [],
        confidence: "low",
        limitations: ["Filename too short for lexical grep heuristics"],
      });
      continue;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["grep", "-l", "--", nameOnly],   // -- separates options from pattern
        { cwd, timeout: 5000, maxBuffer: 10 * 1024 * 1024 }
      );

      const lines = stdout
        .split("\n")
        .map(l => l.trim().replace(/\\/g, "/"))
        .filter(l => l && l !== target.replace(/\\/g, "/"));

      const dependents = lines.slice(0, 10);
      const isTruncated = lines.length > 10;

      results.push({
        source: target,
        dependents,
        confidence: "medium", // lexical: always medium — may have false positives
        limitations: [
          "Lexical search only (no AST); results may include false positives",
          ...(isTruncated ? [`Truncated to 10 files (found ${lines.length})`] : []),
        ],
      });
    } catch (err: any) {
      if (err?.code === 1 && !err?.stderr?.trim()) {
        // git grep exits 1 with no stderr = no matches found
        results.push({
          source: target,
          dependents: [],
          confidence: "high", // confidently no matches
          limitations: ["Lexical search only (no AST)"],
        });
      } else {
        // Real error (git not available, timeout, etc.) → low confidence
        results.push({
          source: target,
          dependents: [],
          confidence: "low",
          limitations: [
            `git grep failed: ${err?.message ?? "unknown error"}`,
            "Dependency data unavailable for this file",
          ],
        });
      }
    }
  }

  return results;
}
