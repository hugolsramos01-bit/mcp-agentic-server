import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClassifiedCheck } from "./check-classifier.js";

const execFileAsync = promisify(execFile);

export interface SuggestChecksOptions {
  paths?: string[];
  scope?: "changed" | "workspace";
  level?: "minimal" | "recommended" | "full";
}

export interface SelectionEvidence {
  path: string;
  rule: string;
}

export interface TargetedCheck extends ClassifiedCheck {
  priority: number;
  evidence: SelectionEvidence[];
}

export interface SuggestChecksResult {
  selectionMode: "targeted" | "workspace";
  changeSource: "provided_paths" | "git_status" | "workspace";
  level: "minimal" | "recommended" | "full";
  changedPaths: string[];
  recommended: TargetedCheck[];
  deferred: Array<{ script: string; reason: string }>;
  stages: {
    initial: string[];
    afterInitialSuccess: string[];
    beforeRelease: string[];
  };
  limitations: string[];
  message?: string;
}

export function normalizePaths(paths: string[]): string[] {
  const result = new Set<string>();
  for (const p of paths) {
    let normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.match(/^[a-zA-Z]:\//)) {
      continue; // reject absolute
    }
    if (normalized.includes("..")) {
      continue; // reject upward traversal
    }
    // Case normalization for windows is tricky without fs hit, but we can lowercase if needed
    // However, keeping original case is safer for cross-platform matches
    if (normalized.length > 0) {
      result.add(normalized);
    }
    if (result.size >= 1000) break; // max 1000
  }
  return Array.from(result);
}

export async function getGitChangedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    const paths = stdout
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        // e.g. "M  src/file.ts" or "?? new.ts" or "R  old -> new"
        const parts = line.substring(3).split(" -> ");
        return parts[parts.length - 1]; // take the target side of renames
      })
      .map(p => {
        // remove surrounding quotes if any
        if (p.startsWith('"') && p.endsWith('"')) {
          return p.slice(1, -1);
        }
        return p;
      });
    return normalizePaths(paths);
  } catch (e) {
    throw new Error("Failed to read git status");
  }
}

export function scoreCheckRules(check: ClassifiedCheck, paths: string[]): { score: number; evidence: SelectionEvidence[] } {
  let score = 0;
  const evidence: SelectionEvidence[] = [];

  const addScore = (points: number, rule: string, path: string) => {
    score += points;
    evidence.push({ rule, path });
  };

  const isDocsOnly = paths.length > 0 && paths.every(p => p.toLowerCase().endsWith(".md") || p.includes("docs/"));
  if (isDocsOnly) {
    addScore(-100, "documentation_only", paths[0]);
    return { score, evidence };
  }

  for (const p of paths) {
    const lower = p.toLowerCase();
    
    // TypeScript / Source code
    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) {
      if (check.tier === "static_analysis" || check.tier === "unit_tests") {
        addScore(30, "typescript_extension", p);
      }
    }

    // Tests
    if (lower.includes(".test.") || lower.includes(".spec.") || lower.includes("__tests__")) {
      if (check.tier === "unit_tests" || check.tier === "general_tests") {
        addScore(50, "direct_test_match", p);
      }
    }

    // HTTP / Transport
    if (lower.includes("http") || lower.includes("server") || lower.includes("router") || lower.includes("oauth")) {
      if (check.tier === "e2e_tests" || check.tier === "integration_tests") {
        addScore(40, "http_transport_path", p);
      }
    }

    // Packaging / Config
    if (lower.includes("package.json") || lower.includes("vite.config") || lower.startsWith("scripts/") || lower.endsWith(".lock")) {
      if (check.tier === "build" || check.tier === "smoke_tests") {
        addScore(60, "package_manifest", p);
      }
    }

    // UI
    if (lower.includes("src/ui/") || lower.endsWith(".css") || lower.endsWith(".html")) {
      if (check.tier === "build") {
        addScore(50, "ui_build", p);
      }
    }
  }

  // Cap score limits if needed, but simple addition is fine
  return { score, evidence };
}

export function determineConfidence(score: number): "low" | "medium" | "high" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function selectTargetedChecks(
  classifiedChecks: ClassifiedCheck[],
  options: SuggestChecksOptions,
  changeSource: "provided_paths" | "git_status",
  changedPaths: string[]
): SuggestChecksResult {
  const level = options.level ?? "recommended";
  
  const result: SuggestChecksResult = {
    selectionMode: "targeted",
    changeSource,
    level,
    changedPaths,
    recommended: [],
    deferred: [],
    stages: {
      initial: [],
      afterInitialSuccess: [],
      beforeRelease: [],
    },
    limitations: []
  };

  if (changedPaths.length === 0) {
    result.message = "No changed files were detected.";
    // push everything as deferred
    for (const check of classifiedChecks) {
      if (!check.mutatesWorkspace) {
        result.deferred.push({ script: check.script, reason: "No files changed" });
      }
    }
    return result;
  }

  let priority = 1;

  for (const check of classifiedChecks) {
    if (check.mutatesWorkspace) continue; // Exclude formatters/fixers

    if (level === "full") {
      // In full mode, recommend all safe checks
      result.recommended.push({
        ...check,
        priority: priority++,
        confidence: check.confidence,
        evidence: [{ path: "*", rule: "full_workspace_level" }]
      });
      continue;
    }

    const { score, evidence } = scoreCheckRules(check, changedPaths);
    const confidence = determineConfidence(score);

    if (score > 0) {
      if (level === "minimal" && confidence !== "high") {
        result.deferred.push({ script: check.script, reason: "Escopo minimal exige alta confiança" });
        continue;
      }
      
      if (level === "minimal" && check.estimatedCost === "high") {
        result.deferred.push({ script: check.script, reason: "Escopo minimal evita checks de alto custo" });
        continue;
      }

      result.recommended.push({
        ...check,
        priority: priority++,
        confidence,
        evidence
      });

      // Populate stages for recommended checks
      if (check.tier === "static_analysis") {
        result.stages.initial.push(check.script);
      } else if (check.tier === "unit_tests" || check.tier === "general_tests") {
        result.stages.initial.push(check.script);
      } else if (check.tier === "build") {
        result.stages.afterInitialSuccess.push(check.script);
      } else {
        result.stages.beforeRelease.push(check.script);
      }
    } else {
      result.deferred.push({ 
        script: check.script, 
        reason: score < 0 ? "Alterações ignoram este tipo de check (ex. apenas documentação)" : "Nenhum sinal detectou relação com os arquivos alterados" 
      });

      // Even if deferred, it might belong in beforeRelease stage
      if (check.tier === "smoke_tests" || check.tier === "e2e_tests" || check.tier === "build") {
        result.stages.beforeRelease.push(check.script);
      }
    }
  }

  // Deduplicate stages
  result.stages.initial = [...new Set(result.stages.initial)];
  result.stages.afterInitialSuccess = [...new Set(result.stages.afterInitialSuccess)];
  result.stages.beforeRelease = [...new Set(result.stages.beforeRelease)];

  return result;
}
