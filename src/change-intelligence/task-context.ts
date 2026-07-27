import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { normalizeGoal } from "./goal-normalizer.js";
import { scoreConfidence } from "./evidence.js";
import { findNearbyTests } from "./test-proximity.js";
import { getWorkspaceFileCacheKey, getWorkspaceFileSnapshot, setWorkspaceFileSnapshot } from "../workspace/workspace-file-cache.js";
import { IndexedPath, isPrimaryEligibleKind, isDependencySkippedKind, candidateKindPriority } from "./indexed-path.js";
import { getLimitedSharedDependencies } from "./file-dependencies-internal.js";
import { TaskContextInput, TaskContextResult, TaskFileCandidate, EvidenceEntry, TaskFileRole, TaskType, TaskContextDepth, CandidateKind } from "./types.js";
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
      normalized.taskTypeSuggestion === "security_review";
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
  let allFileSet: ReadonlySet<string> | undefined;
  let indexedPaths: readonly IndexedPath[] = [];
  
  const cacheKey = getWorkspaceFileCacheKey(input.workspaceId, cwd);
  const snapshot = getWorkspaceFileSnapshot(cacheKey);

  if (snapshot) {
    perf.increment("cacheHits");
    allFiles = snapshot.files.filter(f => !safeExcludeSet.has(f));
    allFileSet = safeExcludeSet.size === 0 ? snapshot.fileSet : new Set(allFiles);
    indexedPaths = snapshot.indexedPaths.filter(p => !safeExcludeSet.has(p.path));
  } else {
    perf.increment("cacheMisses");
    try {
      perf.increment("subprocessCount");
      const { stdout } = await execFileAsync(
        "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd, timeout: 8000, maxBuffer: 10 * 1024 * 1024 }
      );
      const rawFiles = stdout.split("\n")
        .map(f => f.trim().replace(/\\/g, "/"))
        .filter(f => f.length > 0);
        
      const newSnapshot = setWorkspaceFileSnapshot(cacheKey, rawFiles);
      allFiles = newSnapshot.files.filter(f => !safeExcludeSet.has(f));
      // Filter fileSet by excludePaths for accurate O(1) lookups
      allFileSet = safeExcludeSet.size === 0 ? newSnapshot.fileSet : new Set(allFiles);
      indexedPaths = newSnapshot.indexedPaths.filter(p => !safeExcludeSet.has(p.path));
    } catch {
      limitations.push("git ls-files unavailable; filename and content matching disabled");
    }
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

  // Build kind lookup from indexed paths
  const kindMap = new Map<string, CandidateKind>();
  for (const ip of indexedPaths) {
    kindMap.set(ip.path, ip.kind);
  }

  function getKind(path: string): CandidateKind {
    return kindMap.get(path) ?? "source";
  }

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
  const { expandedKeywords, anchorKeywords } = normalized;
  if (indexedPaths.length > 0 && expandedKeywords.length > 0) {
    for (const file of indexedPaths) {
      for (const kw of expandedKeywords) {
        if (kw.length < 3) continue;

        // Filename: exact segment match
        if (matchesFilenameSegment(file.nameOnly, kw)) {
          const type = file.nameOnly === kw ? "filename_exact" : "filename_partial";
          addEvidence(file.path, { type, detail: `Basename segment matches keyword: ${kw}` });
        }

        // Route match: index/page/route files whose directory matches the keyword
        const lowerBase = file.base.toLowerCase();
        if (
          (lowerBase === "page.tsx" || lowerBase === "route.ts" ||
           lowerBase === "index.ts" || lowerBase === "index.js" ||
           lowerBase === "page.ts" || lowerBase === "route.tsx") &&
          dirMatchesKeyword(file.dir, kw)
        ) {
          addEvidence(file.path, { type: "route", detail: `Route file in directory matching keyword: ${kw}` });
        }

        // Schema match: basename contains "schema" and dir or name matches keyword
        if (file.nameOnly.includes("schema") && (matchesFilenameSegment(file.nameOnly, kw) || dirMatchesKeyword(file.dir, kw))) {
          addEvidence(file.path, { type: "schema", detail: `Schema file matching keyword: ${kw}` });
        }
      }
    }
  }
  pPathMatching.end();

  // 9. Content grep — unified single subprocess
  let hasExactFocusPath = false;
  let hasExactExtractedPath = false;
  
  const currentHighCandidates = [];
  for (const [path, evidences] of candidatesMap.entries()) {
    const types = new Set(evidences.map(e => e.type));
    if (types.has("focus_path")) hasExactFocusPath = true;
    if (types.has("extracted_path")) hasExactExtractedPath = true;
    if (scoreConfidence(evidences) === "high" && isPrimaryEligibleKind(getKind(path))) {
      currentHighCandidates.push({ path, evidences });
    }
  }

  const hasUniqueHighConfidenceIndexedCandidate =
    currentHighCandidates.length === 1 &&
    currentHighCandidates[0].evidences.length >= 2;

  const directContextSufficient =
    hasExactFocusPath ||
    hasExactExtractedPath ||
    hasUniqueHighConfidenceIndexedCandidate;

  const shouldRunContentSearch =
    !directContextSufficient &&
    anchorKeywords.some(kw => kw.length >= 4);

  if (shouldRunContentSearch) {
    const pContentSearch = perf.startPhase("contentSearch");
    const grepKeywords = anchorKeywords.slice(0, 5).filter(kw => kw.length >= 4);
    
    if (grepKeywords.length > 0) {
      const grepArgs = ["grep", "-i", "-l", "-F"];
      for (const kw of grepKeywords) {
        grepArgs.push("-e", kw);
      }
      
      try {
        perf.increment("subprocessCount");
        const { stdout } = await execFileAsync(
          "git", grepArgs,
          { cwd, timeout: 5000, maxBuffer: 10 * 1024 * 1024 }
        );
        const grepFiles = stdout.split("\n").map(f => f.trim().replace(/\\/g, "/")).filter(Boolean);
        // Sort by CandidateKind priority before cap — prefer source/test over docs/eval
        const orderedGrepFiles = grepFiles
          .map(path => ({ path, kind: getKind(path) }))
          .sort((a, b) => candidateKindPriority(a.kind) - candidateKindPriority(b.kind));
        for (const { path } of orderedGrepFiles.slice(0, 20)) {
          addEvidence(path, { type: "content_match", detail: `Contains matching keywords` });
        }
      } catch (err: any) {
        if (err?.code !== 1) { // 1 means no match, normal for grep
          limitations.push(`unified git grep failed: ${err?.message ?? "unknown error"}`);
        }
      }
    }
    pContentSearch.end();
  }

  // 10. Test proximity — discover and add as supporting evidence
  const nearbyTestCandidates: TaskContextResult["nearbyTestCandidates"] = [];
  const pTestDiscovery = perf.startPhase("testProximity");
    // Use a stable snapshot of candidatesMap keys (don't iterate over newly added test entries)
    const testDiscoverySources = [...candidatesMap.keys()].filter(path => getKind(path) !== "test");
    for (const path of testDiscoverySources) {
      const tests = findNearbyTests(path, allFiles, allFileSet);
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
    const kind = getKind(path);

    // Allow explicit override: focus_path/extracted_path can promote any kind
    const explicitlyTargeted = evidences.some(e =>
      e.type === "focus_path" || e.type === "extracted_path"
    );

    let role: TaskFileRole = "supporting";
    if (kind === "test") {
      role = "test"; // always supporting, no matter the confidence
    } else if (confidence === "high" && (isPrimaryEligibleKind(kind) || explicitlyTargeted)) {
      role = "primary";
    }
    // Everything else (evaluation, snapshot, generated, documentation)
    // stays as "supporting" even with high confidence, UNLESS explicitly targeted

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

  // 12. Direct dependents — limited to top 3 primary files (skip eval/snapshot/generated/docs)
  let directDependents: TaskContextResult["directDependents"] = [];
  if (effectiveDepth !== "fast") {
    const pDependencySearch = perf.startPhase("dependencySearch");
    const primaryEligible = primaryFiles
      .slice(0, 3)
      .map(c => c.path)
      .filter(p => isPrimaryEligibleKind(getKind(p)));
    directDependents = await getLimitedSharedDependencies(
    cwd,
    primaryEligible
    );
    pDependencySearch.end();
  }

  // 13. Build result (without nextSteps — rebuilt after budget enforcement)
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
    suggestedNextSteps: [], // will be rebuilt after budget
    limitations,
    budget: {
      maxTokens,
      estimatedTokens: 0,
      truncated: false,
      omittedCandidates: 0,
    },
  };

  const result = enforceTaskContextBudget(finalResult, maxTokens);

  // Rebuild suggestedNextSteps based on actual retained files after budget enforcement
  result.suggestedNextSteps = buildSuggestedNextSteps(result, anchorKeywords);

  // Final budget measurement — includes suggestedNextSteps. If still over, trim and rebuild.
  const finalResultWithSteps = enforceFinalContextBudget(result, maxTokens, anchorKeywords);

  pBudget.end();
  return finalResultWithSteps;
}

// ─── Suggested next steps builder (runs after budget enforcement) ─────

function buildSuggestedNextSteps(result: TaskContextResult, anchorKeywords: string[]): TaskContextResult["suggestedNextSteps"] {
  const steps: TaskContextResult["suggestedNextSteps"] = [];

  if (result.primaryFiles.length > 0) {
    steps.push({
      tool: "read_many",
      arguments: { paths: result.primaryFiles.slice(0, 5).map(c => c.path) },
      reason: "Read the strongest implementation candidates."
    });
  } else if (result.supportingFiles.length > 0) {
    steps.push({
      tool: "read_adaptive",
      arguments: { path: result.supportingFiles[0].path },
      reason: "No high-confidence primary file was found; inspect the strongest supporting candidate."
    });
  } else {
    steps.push({
      tool: "grep",
      arguments: { pattern: anchorKeywords.slice(0, 3).join("|") },
      reason: "No reliable file candidate was found; search for the normalized goal terms."
    });
  }

  return steps;
}

// ─── Budget enforcement by real JSON size ─────────────────────────────

function enforceTaskContextBudget(result: TaskContextResult, maxTokens: number): TaskContextResult {
  const measureTokens = () => Math.ceil(JSON.stringify(result).length / 4);
  let currentTokens = measureTokens();

  let omittedCandidates = 0;
  let truncated = false;

  const estimateCandidateTokens = (c: any) => Math.ceil(JSON.stringify(c).length / 4);

  // Trim supporting files first (lowest priority), from the end (lowest confidence)
  while (currentTokens > maxTokens && result.supportingFiles.length > 0) {
    const popped = result.supportingFiles.pop();
    currentTokens -= estimateCandidateTokens(popped);
    omittedCandidates++;
    truncated = true;
  }

  // Trim primary files only after all supporting is gone, always keep at least 1
  while (currentTokens > maxTokens && result.primaryFiles.length > 1) {
    const popped = result.primaryFiles.pop();
    currentTokens -= estimateCandidateTokens(popped);
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
  }

  result.budget = {
    maxTokens,
    estimatedTokens: measureTokens(),
    truncated,
    omittedCandidates,
  };

  return result;
}

// ─── Final budget enforcement (includes suggestedNextSteps in measurement) ──

function cleanDerivedStructures(result: TaskContextResult): void {
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
}

function enforceFinalContextBudget(result: TaskContextResult, maxTokens: number, anchorKeywords: string[]): TaskContextResult {
  const measureTokens = () => Math.ceil(JSON.stringify(result).length / 4);
  let exactTokens = measureTokens();

  let omittedCandidates = result.budget.omittedCandidates;

  // Loop: trim, rebuild nextSteps, measure — repeat until within budget or minimum structure reached
  while (
    exactTokens > maxTokens &&
    (result.supportingFiles.length > 0 || result.primaryFiles.length > 1)
  ) {
    if (result.supportingFiles.length > 0) {
      result.supportingFiles.pop();
    } else {
      result.primaryFiles.pop();
    }
    omittedCandidates++;

    cleanDerivedStructures(result);
    result.suggestedNextSteps = buildSuggestedNextSteps(result, anchorKeywords);
    exactTokens = measureTokens();
  }

  if (omittedCandidates > result.budget.omittedCandidates) {
    result.limitations.push(
      `Budget: omitted ${omittedCandidates} candidate(s) (final) to stay within ${maxTokens} tokens.`
    );
  }

  if (exactTokens > maxTokens) {
    result.limitations.push(
      "Minimum task context structure exceeds the requested token budget."
    );
  }

  result.budget = {
    maxTokens,
    estimatedTokens: exactTokens,
    truncated: exactTokens > maxTokens || result.budget.truncated,
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
    workspaceId?: string;
    goal: string;
    type?: TaskType;
    maxTokens?: number;
    focusPaths?: string[];
    excludePaths?: string[];
    depth?: TaskContextDepth;
  },
  perf?: PerformanceRecorder
): Promise<ToolResponse> {
  const resolvedMaxTokens = input.maxTokens ?? TASK_CONTEXT_BUDGET.defaultTokens;

  const result = await buildTaskContext({
    workspaceId: input.workspaceId ?? cwd,
    cwd,
    allowedRoots,
    goal: input.goal,
    type: input.type,
    focusPaths: input.focusPaths,
    excludePaths: input.excludePaths,
    depth: input.depth,
    maxTokens: resolvedMaxTokens,
    perf
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}
