import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { normalizeGoal } from "./goal-normalizer.js";
import { scoreConfidence } from "./evidence.js";
import { findNearbyTests } from "./test-proximity.js";
import { getLimitedSharedDependencies } from "./file-dependencies-internal.js";
import { TaskContextInput, TaskContextResult, TaskFileCandidate, EvidenceEntry, TaskFileRole, TaskType, TaskContextDepth } from "./types.js";
import type { ToolResponse } from "../pi-tools.js";
import { NOOP_PERFORMANCE_RECORDER } from "../performance/performance-recorder.js";

const execFileAsync = promisify(execFile);

// ─── Budget ────────────────────────────────────────────────────────────
export const TASK_CONTEXT_BUDGET = {
  minTokens: 1_000,
  defaultTokens: 6_000,
  maxTokens: 12_000,
} as const;

// ─── Matching helpers ──────────────────────────────────────────────────

/** Exact segment match for basenames: splits by -, _, ., camelCase boundaries. */
function matchesFilenameSegment(nameOnly: string, kw: string): boolean {
  const segments = nameOnly
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_. ]+/);
  return segments.includes(kw);
}

/** Exact + controlled plural (s/es) for directory tokens. No generic startsWith. */
function matchesDirectoryToken(segment: string, keyword: string): boolean {
  if (segment === keyword) return true;
  const suffix = segment.slice(keyword.length);
  return (
    keyword.length >= 4 &&
    segment.startsWith(keyword) &&
    (suffix === "s" || suffix === "es")
  );
}

function dirMatchesKeyword(dir: string, kw: string): boolean {
  return dir.split(/[\\/]+/).some(s => matchesDirectoryToken(s.toLowerCase(), kw));
}

// ─── Path validation ───────────────────────────────────────────────────

/**
 * Resolves and validates a user-supplied path against cwd and allowedRoots.
 * Returns the relative path if valid, or null if it should be rejected.
 */
function resolveAndValidatePath(
  rawPath: string,
  cwd: string,
  allowedRoots: string[],
  limitations: string[]
): string | null {
  // Reject empty
  if (!rawPath || rawPath.trim() === "") return null;

  // Normalize separators to forward-slash for comparison
  const normalized = rawPath.replace(/\\/g, "/").trim();

  // Reject absolute paths not under any allowed root
  if (isAbsolute(normalized)) {
    const abs = normalize(normalized);
    const allowed = allowedRoots.some(r => abs.startsWith(normalize(r)));
    if (!allowed) {
      limitations.push(`Rejected absolute path outside allowedRoots: ${rawPath}`);
      return null;
    }
    // Convert to relative
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    if (rel.startsWith("..")) {
      limitations.push(`Rejected path escaping workspace: ${rawPath}`);
      return null;
    }
    return rel;
  }

  // Reject traversal
  const rel = normalize(join(cwd, normalized)).replace(/\\/g, "/");
  const cwdNorm = normalize(cwd).replace(/\\/g, "/");
  if (!rel.startsWith(cwdNorm)) {
    limitations.push(`Rejected path traversal: ${rawPath}`);
    return null;
  }

  return normalized;
}

// ─── Core ─────────────────────────────────────────────────────────────

export async function buildTaskContext(input: TaskContextInput): Promise<TaskContextResult> {
  const {
    cwd,
    allowedRoots,
    goal,
    type,
    focusPaths = [],
    excludePaths = [],
    maxTokens = TASK_CONTEXT_BUDGET.defaultTokens,
    depth,
  } = input;
  const perf = input.perf ?? NOOP_PERFORMANCE_RECORDER;
  const limitations: string[] = [];

  // 1. Goal Normalization
  const pNormalize = perf.startPhase("normalizeGoal");
  const normalized = normalizeGoal(goal, type);
  pNormalize.end();

  // Depth Resolution
  let effectiveDepth: TaskContextDepth = "balanced";
  let depthSource: "explicit" | "inferred" | "default" = "default";

  if (depth) {
    effectiveDepth = depth;
    depthSource = "explicit";
  } else {
    const isMajor =
      normalized.taskTypeSuggestion === "migration" ||
      normalized.taskTypeSuggestion === "refactor" ||
      normalized.taskTypeSuggestion === "security";
    if (isMajor) {
      effectiveDepth = "balanced";
      depthSource = "inferred";
    } else {
      effectiveDepth = "fast";
      depthSource = "default";
    }
  }

  // 2. Validate focusPaths and excludePaths
  const pResolve = perf.startPhase("resolvePaths");
  const safeFocusPaths = focusPaths
    .map(fp => resolveAndValidatePath(fp, cwd, allowedRoots, limitations))
    .filter((fp): fp is string => fp !== null);

  const safeExcludeSet = new Set(
    excludePaths
      .map(ep => resolveAndValidatePath(ep, cwd, allowedRoots, limitations))
      .filter((ep): ep is string => ep !== null)
  );
  pResolve.end();

  // 3. Gather all tracked files (excluding excluded paths)
  const pLoadFileList = perf.startPhase("loadFileList");
  let allFiles: string[] = [];
  try {
    perf.increment("subprocessCount");
    const { stdout } = await execFileAsync(
      "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: 8000, maxBuffer: 10 * 1024 * 1024 }
    );
    allFiles = stdout.split("\n")
      .map(f => f.trim().replace(/\\/g, "/"))
      .filter(f => f.length > 0 && !safeExcludeSet.has(f));
  } catch {
    limitations.push("git ls-files unavailable; filename and content matching disabled");
  }
  pLoadFileList.end();

  // 4. Detect workspace instruction files
  const pPathMatching = perf.startPhase("pathMatching");
  const applicableInstructions: TaskContextResult["applicableInstructions"] = allFiles
    .filter(f =>
      f.endsWith("AGENTS.md") ||
      f.endsWith("CLAUDE.md") ||
      f.endsWith(".cursorrules") ||
      f.includes(".agentic/") ||
      f.includes(".agents/")
    )
    .map(f => ({
      path: f,
      scope: (f.includes(".agentic/") || f.includes(".agents/")) ? "workspace" : "global",
      reason: "Instruction file detected in workspace"
    }));

  // Override if caller provided explicit instruction files
  if (input.instructionFiles && input.instructionFiles.length > 0) {
    applicableInstructions.length = 0;
    for (const inst of input.instructionFiles) {
      applicableInstructions.push({ path: inst, scope: "workspace", reason: "Provided by caller" });
    }
  }

  // 5. Candidates map: path → evidence[]
  const candidatesMap = new Map<string, EvidenceEntry[]>();

  function addEvidence(path: string, ev: EvidenceEntry) {
    if (safeExcludeSet.has(path)) return; // respect excludePaths for all additions
    if (!candidatesMap.has(path)) candidatesMap.set(path, []);
    const existing = candidatesMap.get(path)!;
    if (!existing.some(e => e.type === ev.type && e.detail === ev.detail)) {
      existing.push(ev);
    }
  }

  // 6. Focus paths (explicitly provided)
  for (const fp of safeFocusPaths) {
    addEvidence(fp, { type: "focus_path", detail: "Provided directly in focusPaths" });
  }

  // 7. Paths extracted from goal text
  for (const ep of normalized.extractedPaths) {
    if (allFiles.length === 0 || allFiles.includes(ep) || allFiles.some(f => f.endsWith(ep))) {
      const match = allFiles.find(f => f.endsWith(ep)) ?? ep;
      addEvidence(match, { type: "extracted_path", detail: "Extracted from goal text" });
    }
  }

  // 8. Filename / Route / Schema matching (segment-based)
  const { expandedKeywords } = normalized;
  if (allFiles.length > 0 && expandedKeywords.length > 0) {
    for (const file of allFiles) {
      const base = basename(file);
      const dir = dirname(file);
      const dotIndex = base.lastIndexOf(".");
      const nameOnly = dotIndex !== -1 ? base.substring(0, dotIndex).toLowerCase() : base.toLowerCase();

      for (const kw of expandedKeywords) {
        if (kw.length < 3) continue;

        // Filename: exact segment match
        if (matchesFilenameSegment(nameOnly, kw)) {
          const type = nameOnly === kw ? "filename_exact" : "filename_partial";
          addEvidence(file, { type, detail: `Basename segment matches keyword: ${kw}` });
        }

        // Route match: index/page/route files whose directory matches the keyword
        const lowerBase = base.toLowerCase();
        if (
          (lowerBase === "page.tsx" || lowerBase === "route.ts" ||
           lowerBase === "index.ts" || lowerBase === "index.js" ||
           lowerBase === "page.ts" || lowerBase === "route.tsx") &&
          dirMatchesKeyword(dir, kw)
        ) {
          addEvidence(file, { type: "route", detail: `Route file in directory matching keyword: ${kw}` });
        }

        // Schema match: basename contains "schema" and dir or name matches keyword
        if (nameOnly.includes("schema") && (matchesFilenameSegment(nameOnly, kw) || dirMatchesKeyword(dir, kw))) {
          addEvidence(file, { type: "schema", detail: `Schema file matching keyword: ${kw}` });
        }
      }
    }
  }
  pPathMatching.end();

  // 9. Content grep — per-keyword, individual try/catch
  const pContentSearch = perf.startPhase("contentSearch");
  for (const kw of expandedKeywords.slice(0, 5)) {
    if (kw.length < 4) continue;
    try {
      perf.increment("subprocessCount");
      const { stdout } = await execFileAsync(
        "git", ["grep", "-i", "-l", "--", kw],
        { cwd, timeout: 5000, maxBuffer: 10 * 1024 * 1024 }
      );
      const grepFiles = stdout.split("\n").map(f => f.trim().replace(/\\/g, "/")).filter(Boolean);
      for (const gf of grepFiles.slice(0, 20)) {
        addEvidence(gf, { type: "content_match", detail: `Contains keyword: ${kw}` });
      }
    } catch (err: any) {
      if (err?.code === 1) continue; // no-match: normal git grep exit
      limitations.push(`git grep failed for keyword "${kw}": ${err?.message ?? "unknown error"}`);
    }
  }
  pContentSearch.end();

  // 10. Test proximity — discover and add as supporting evidence
  const pTestDiscovery = perf.startPhase("testDiscovery");
  const nearbyTestCandidates: TaskContextResult["nearbyTestCandidates"] = [];
  for (const [path] of candidatesMap.entries()) {
    const tests = await findNearbyTests(join(cwd, path), cwd);
    if (tests.length > 0) {
      addEvidence(path, { type: "test_proximity", detail: `Has nearby tests: ${tests.join(", ")}` });
      nearbyTestCandidates.push({ sourcePath: path, testPaths: tests });
      for (const t of tests) {
        addEvidence(t, { type: "test_proximity", detail: `Is test for: ${path}` });
      }
    }
  }
  pTestDiscovery.end();

  // 11. Initial assignment of confidence & sorting deterministically
  const confidenceScore: Record<string, number> = { high: 3, medium: 2, low: 1 };

  const allCandidates: TaskFileCandidate[] = Array.from(candidatesMap.entries()).map(([path, evidences]) => {
    const confidence = scoreConfidence(evidences);

    let role: TaskFileRole = "supporting";
    if (path.includes(".test.") || path.includes(".spec.") || path.includes("__tests__")) {
      role = "test"; // always supporting
    } else if (confidence === "high") {
      role = "primary";
    }

    const recommendedReadTool: "read" | "read_adaptive" | "read_many" =
      confidence === "high" ? "read" :
      confidence === "medium" ? "read_adaptive" :
      "read_many";

    return { path, role, confidence, evidence: evidences, recommendedReadTool };
  });

  allCandidates.sort((a, b) => {
    const cs = confidenceScore[b.confidence] - confidenceScore[a.confidence];
    if (cs !== 0) return cs;
    const es = b.evidence.length - a.evidence.length;
    if (es !== 0) return es;
    return a.path.localeCompare(b.path);
  });

  // Tests go to supporting; primary and non-test high-confidence go to primary
  const primaryFiles: TaskFileCandidate[] = [];
  const supportingFiles: TaskFileCandidate[] = [];
  for (const c of allCandidates) {
    if (c.role === "primary") {
      primaryFiles.push(c);
    } else {
      supportingFiles.push(c); // test, supporting, or configuration
    }
  }

  // 12. Direct dependents — limited to top 3 primary files
  const pDependencySearch = perf.startPhase("dependencySearch");
  const directDependents = await getLimitedSharedDependencies(
    cwd,
    primaryFiles.slice(0, 3).map(c => c.path)
  );
  pDependencySearch.end();

  // 13. Suggested next steps
  const suggestedNextSteps: TaskContextResult["suggestedNextSteps"] = [];
  if (primaryFiles.length > 0) {
    suggestedNextSteps.push({
      tool: "read_many",
      arguments: { paths: primaryFiles.slice(0, 5).map(c => c.path) },
      reason: "Read the most confident primary candidates to understand implementation details."
    });
  }

  // 14. Build result and enforce real budget
  const pBudget = perf.startPhase("budgetEnforcement");
  const finalResult: TaskContextResult = {
    version: 1,
    goal: input.goal,
    taskType: normalized.taskTypeSuggestion,
    taskTypeSource: normalized.taskTypeSource,
    requestedDepth: depth,
    effectiveDepth,
    depthSource,
    primaryFiles,
    supportingFiles,
    directDependents,
    applicableInstructions,
    nearbyTestCandidates,
    suggestedNextSteps,
    limitations,
    budget: {
      maxTokens,
      estimatedTokens: 0,
      truncated: false,
      omittedCandidates: 0,
    },
  };

  const result = enforceTaskContextBudget(finalResult, maxTokens);
  pBudget.end();
  return result;
}

// ─── Budget enforcement by real JSON size ─────────────────────────────

function enforceTaskContextBudget(result: TaskContextResult, maxTokens: number): TaskContextResult {
  const measureTokens = () => Math.ceil(JSON.stringify(result).length / 4);

  let omittedCandidates = 0;
  let truncated = false;

  // Trim supporting files first (lowest priority), from the end (lowest confidence)
  while (measureTokens() > maxTokens && result.supportingFiles.length > 0) {
    result.supportingFiles.pop();
    omittedCandidates++;
    truncated = true;
  }

  // Trim primary files only after all supporting is gone, always keep at least 1
  while (measureTokens() > maxTokens && result.primaryFiles.length > 1) {
    result.primaryFiles.pop();
    omittedCandidates++;
    truncated = true;
  }

  if (truncated) {
    result.limitations.push(
      `Budget: omitted ${omittedCandidates} candidate(s) to stay within ${maxTokens} tokens.`
    );

    // Clean up references to truncated files
    const retainedPaths = new Set([
      ...result.primaryFiles.map(file => file.path),
      ...result.supportingFiles.map(file => file.path),
    ]);

    result.directDependents = result.directDependents.filter(item =>
      retainedPaths.has(item.source)
    );

    result.nearbyTestCandidates = result.nearbyTestCandidates
      .filter(item => retainedPaths.has(item.sourcePath))
      .map(item => ({
        ...item,
        testPaths: item.testPaths.filter(path => retainedPaths.has(path)),
      }));

    for (const step of result.suggestedNextSteps) {
      if (Array.isArray(step.arguments.paths)) {
        step.arguments.paths = step.arguments.paths.filter(path =>
          retainedPaths.has(String(path))
        );
      }
    }
  }

  result.budget = {
    maxTokens,
    estimatedTokens: measureTokens(),
    truncated,
    omittedCandidates,
  };

  return result;
}

// ─── MCP adapter ──────────────────────────────────────────────────────

import type { PerformanceRecorder } from "../performance/performance-recorder.js";

export async function taskContextTool(
  cwd: string,
  allowedRoots: string[],
  input: {
    goal: string;
    type?: TaskType;
    maxTokens?: number;
    focusPaths?: string[];
    excludePaths?: string[];
  },
  perf?: PerformanceRecorder
): Promise<ToolResponse> {
  const resolvedMaxTokens = input.maxTokens ?? TASK_CONTEXT_BUDGET.defaultTokens;

  const result = await buildTaskContext({
    cwd,
    allowedRoots,
    goal: input.goal,
    type: input.type,
    focusPaths: input.focusPaths,
    excludePaths: input.excludePaths,
    maxTokens: resolvedMaxTokens,
    perf
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}
