import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { normalizeGoal } from "./goal-normalizer.js";
import {
  inferConfidence,
  WEAK_GOAL_KEYWORDS,
  EVIDENCE_WEIGHTS,
  KIND_PENALTIES,
} from "./evidence.js";
import { findNearbyTests } from "./test-proximity.js";
import {
  getWorkspaceFileCacheKey,
  getWorkspaceFileSnapshot,
  setWorkspaceFileSnapshot,
} from "../workspace/workspace-file-cache.js";
import {
  IndexedPath,
  isPrimaryEligibleKind,
  isDependencySkippedKind,
  candidateKindPriority,
  isLockFile,
} from "./indexed-path.js";
import { getLimitedSharedDependencies } from "./file-dependencies-internal.js";
import {
  TaskContextInput,
  TaskContextResult,
  TaskFileCandidate,
  EvidenceEntry,
  TaskFileRole,
  TaskType,
  TaskContextDepth,
  CandidateKind,
  GoalIntent,
  CandidateAssessment,
} from "./types.js";
import { calculateRiskProfile } from "./risk-profile.js";
import {
  loadAndExtractCodeRegions,
  CodeRegionSkippedError,
} from "./code-region-cache.js";
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
  return dir
    .split(/[\\/]+/)
    .some((s) => matchesDirectoryToken(s.toLowerCase(), kw));
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
  limitations: string[],
): string | null {
  // Reject empty
  if (!rawPath || rawPath.trim() === "") return null;

  // Normalize separators to forward-slash for comparison
  const normalized = rawPath.replace(/\\/g, "/").trim();

  // Reject absolute paths not under any allowed root
  if (isAbsolute(normalized)) {
    const abs = normalize(normalized);
    const allowed = allowedRoots.some((r) => abs.startsWith(normalize(r)));
    if (!allowed) {
      limitations.push(
        `Rejected absolute path outside allowedRoots: ${rawPath}`,
      );
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

function inferGoalIntent(
  goal: string,
  type: TaskType,
  focusPaths: string[],
): GoalIntent {
  const g = goal.toLowerCase();
  const tokens = new Set(g.match(/[a-z0-9_]+/g) ?? []);

  const testingIntent =
    ["test", "tests", "testing", "spec", "specs"].some((token) =>
      tokens.has(token),
    ) || focusPaths.some((path) => /\.(?:test|spec)\./i.test(path));

  if (testingIntent || (type === "auto" && testingIntent)) return "testing";
  if (g.includes("config") || g.includes("eslint") || g.includes("tsconfig"))
    return "configuration";
  if (g.includes("doc") || g.includes("readme")) return "documentation";
  if (g.includes("investigat") || g.includes("why") || g.includes("explain"))
    return "investigation";
  return "implementation";
}

export async function buildTaskContext(
  input: TaskContextInput,
): Promise<TaskContextResult> {
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
  const focusWasRequested = focusPaths.length > 0;
  const safeFocusPaths = focusPaths
    .map((fp) => resolveAndValidatePath(fp, cwd, allowedRoots, limitations))
    .filter((fp): fp is string => fp !== null);

  const safeExcludePaths = excludePaths
    .map((ep) => resolveAndValidatePath(ep, cwd, allowedRoots, limitations))
    .filter((ep): ep is string => ep !== null);

  function normalizeScopePath(path: string): string {
    const normalized = path
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
  }

  interface ResolvedFocusScope {
    active: boolean;
    exactFiles: Set<string>;
    directoryPrefixes: string[];
    unresolved: string[];
  }

  function resolveFocusScope(
    validatedFocusPaths: string[],
    allFiles: readonly string[],
    allFileSet: ReadonlySet<string>,
    active: boolean,
  ): ResolvedFocusScope {
    const exactFiles = new Set<string>();
    const directoryPrefixes: string[] = [];
    const unresolved: string[] = [];

    for (const rawPath of validatedFocusPaths) {
      const path = normalizeScopePath(rawPath);

      if (path === "") {
        directoryPrefixes.push("");
        continue;
      }

      if (allFileSet.has(path)) {
        exactFiles.add(path);
        continue;
      }

      const prefix = `${path}/`;
      if (allFiles.some((file) => file.startsWith(prefix))) {
        directoryPrefixes.push(path);
        continue;
      }

      unresolved.push(rawPath);
    }

    return {
      active,
      exactFiles,
      directoryPrefixes,
      unresolved,
    };
  }

  function isInsideFocusScope(
    path: string,
    scope: ResolvedFocusScope,
  ): boolean {
    if (!scope.active) return true;
    const normalized = normalizeScopePath(path);
    if (scope.exactFiles.has(normalized)) return true;
    return scope.directoryPrefixes.some(
      (prefix) => prefix === "" || normalized.startsWith(`${prefix}/`),
    );
  }

  function isPathExcluded(path: string): boolean {
    const normalizedPath = normalizeScopePath(path);
    return safeExcludePaths.some((excluded) => {
      const prefix = normalizeScopePath(excluded);
      return (
        normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
      );
    });
  }

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
    allFiles = snapshot.files.filter((f) => !isPathExcluded(f));
    allFileSet =
      safeExcludePaths.length === 0 ? snapshot.fileSet : new Set(allFiles);
    indexedPaths = snapshot.indexedPaths.filter((p) => !isPathExcluded(p.path));
  } else {
    perf.increment("cacheMisses");
    try {
      perf.increment("subprocessCount");
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd, timeout: 8000, maxBuffer: 10 * 1024 * 1024 },
      );
      const rawFiles = stdout
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter((f) => f.length > 0);

      const newSnapshot = setWorkspaceFileSnapshot(cacheKey, rawFiles);
      allFiles = newSnapshot.files.filter((f) => !isPathExcluded(f));
      // Filter fileSet by excludePaths for accurate O(1) lookups
      allFileSet =
        safeExcludePaths.length === 0 ? newSnapshot.fileSet : new Set(allFiles);
      indexedPaths = newSnapshot.indexedPaths.filter(
        (p) => !isPathExcluded(p.path),
      );
    } catch {
      limitations.push(
        "git ls-files unavailable; filename and content matching disabled",
      );
    }
  }
  pLoadFileList.end();

  const focusScope = resolveFocusScope(
    safeFocusPaths,
    allFiles,
    allFileSet ?? new Set(allFiles),
    focusWasRequested,
  );

  for (const unresolved of focusScope.unresolved) {
    limitations.push(`Focus path was not found: ${unresolved}`);
  }

  const discoveryFiles = allFiles.filter((file) =>
    isInsideFocusScope(file, focusScope),
  );
  const discoveryIndexedPaths = indexedPaths.filter((indexed) =>
    isInsideFocusScope(indexed.path, focusScope),
  );

  // 4. Detect workspace instruction files
  const pPathMatching = perf.startPhase("pathMatching");
  const applicableInstructions: TaskContextResult["applicableInstructions"] =
    allFiles
      .filter(
        (f) =>
          f.endsWith("AGENTS.md") ||
          f.endsWith("CLAUDE.md") ||
          f.endsWith(".cursorrules") ||
          f.includes(".agentic/") ||
          f.includes(".agents/"),
      )
      .map((f) => ({
        path: f,
        scope:
          f.includes(".agentic/") || f.includes(".agents/")
            ? "workspace"
            : "global",
        reason: "Instruction file detected in workspace",
      }));

  // Override if caller provided explicit instruction files
  if (input.instructionFiles && input.instructionFiles.length > 0) {
    applicableInstructions.length = 0;
    for (const inst of input.instructionFiles) {
      applicableInstructions.push({
        path: inst,
        scope: "workspace",
        reason: "Provided by caller",
      });
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

  type EvidenceScope = "discovery" | "supporting";

  function addEvidence(
    path: string,
    ev: EvidenceEntry,
    scope: EvidenceScope = "discovery",
  ) {
    if (isPathExcluded(path)) return; // respect excludePaths for all additions

    if (scope === "discovery" && !isInsideFocusScope(path, focusScope)) {
      return;
    }

    if (!candidatesMap.has(path)) candidatesMap.set(path, []);
    const existing = candidatesMap.get(path)!;
    if (!existing.some((e) => e.type === ev.type && e.detail === ev.detail)) {
      existing.push(ev);
    }
  }

  // 6. Focus paths (explicitly provided)
  for (const file of focusScope.exactFiles) {
    addEvidence(
      file,
      { type: "focus_path", detail: "Provided directly in focusPaths" },
      "discovery",
    );
  }

  // 7. Paths extracted from goal text
  for (const ep of normalized.extractedPaths) {
    const match = discoveryFiles.find((f) => f === ep || f.endsWith(ep));
    if (match) {
      addEvidence(
        match,
        { type: "extracted_path", detail: "Extracted from goal text" },
        "discovery",
      );
    }
  }

  // 8. Filename / Route / Schema matching (segment-based)
  const { expandedKeywords, anchorKeywords } = normalized;
  if (discoveryIndexedPaths.length > 0 && expandedKeywords.length > 0) {
    for (const file of discoveryIndexedPaths) {
      for (const kw of expandedKeywords) {
        if (kw.length < 3) continue;

        // Filename: exact segment match
        if (matchesFilenameSegment(file.nameOnly, kw)) {
          addEvidence(file.path, {
            type: "filename_exact",
            detail: `Basename segment matches keyword: ${kw}`,
          });
        } else if (file.nameOnly.includes(kw)) {
          addEvidence(file.path, {
            type: "filename_partial",
            detail: `Basename contains keyword: ${kw}`,
          });
        }

        // Route match: index/page/route files whose directory matches the keyword
        const lowerBase = file.base.toLowerCase();
        if (
          (lowerBase === "page.tsx" ||
            lowerBase === "route.ts" ||
            lowerBase === "index.ts" ||
            lowerBase === "index.js" ||
            lowerBase === "page.ts" ||
            lowerBase === "route.tsx") &&
          dirMatchesKeyword(file.dir, kw)
        ) {
          addEvidence(file.path, {
            type: "route",
            detail: `Route file in directory matching keyword: ${kw}`,
          });
        }

        // Schema match: basename contains "schema" and dir or name matches keyword
        if (
          file.nameOnly.includes("schema") &&
          (matchesFilenameSegment(file.nameOnly, kw) ||
            dirMatchesKeyword(file.dir, kw))
        ) {
          addEvidence(file.path, {
            type: "schema",
            detail: `Schema file matching keyword: ${kw}`,
          });
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
    const types = new Set(evidences.map((e) => e.type));
    if (types.has("focus_path")) hasExactFocusPath = true;
    if (types.has("extracted_path")) hasExactExtractedPath = true;
    if (
      inferConfidence(evidences) === "high" &&
      isPrimaryEligibleKind(getKind(path))
    ) {
      currentHighCandidates.push({ path, evidences });
    }
  }

  const hasUniqueHighConfidenceIndexedCandidate =
    currentHighCandidates.length === 1 &&
    currentHighCandidates[0].evidences.length >= 2;

  const hasDirectoryFocus = focusScope.directoryPrefixes.length > 0;

  const directContextSufficient =
    !hasDirectoryFocus &&
    (hasExactFocusPath ||
      hasExactExtractedPath ||
      hasUniqueHighConfidenceIndexedCandidate);

  const shouldRunContentSearch =
    !directContextSufficient && anchorKeywords.some((kw) => kw.length >= 4);

  if (shouldRunContentSearch) {
    const pContentSearch = perf.startPhase("contentSearch");
    const grepKeywords = anchorKeywords
      .slice(0, 5)
      .filter((kw) => kw.length >= 4);

    if (grepKeywords.length > 0) {
      const grepArgs = ["grep", "-i", "-l", "-F"];
      for (const kw of grepKeywords) {
        grepArgs.push("-e", kw);
      }

      const hasRootFocus = focusScope.directoryPrefixes.includes("");
      const scopedPathspecs = [
        ...focusScope.exactFiles,
        ...focusScope.directoryPrefixes.filter((prefix) => prefix !== ""),
      ];
      const hasResolvedFocus = hasRootFocus || scopedPathspecs.length > 0;

      if (focusScope.active && !hasRootFocus && scopedPathspecs.length > 0) {
        grepArgs.push(
          "--",
          ...scopedPathspecs.map((path) => `:(literal)${path}`),
        );
      }

      if (focusScope.active && !hasResolvedFocus) {
        // foco inválido: não executar grep
      } else {
        try {
          perf.increment("subprocessCount");
          const { stdout } = await execFileAsync("git", grepArgs, {
            cwd,
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024,
          });
          const grepFiles = stdout
            .split("\n")
            .map((f) => f.trim().replace(/\\/g, "/"))
            .filter(Boolean)
            .filter((file) => isInsideFocusScope(file, focusScope));

          // Sort by CandidateKind priority before cap — prefer source/test over docs/eval
          const orderedGrepFiles = grepFiles
            .map((path) => ({ path, kind: getKind(path) }))
            .sort(
              (a, b) =>
                candidateKindPriority(a.kind) - candidateKindPriority(b.kind),
            );

          for (const { path } of orderedGrepFiles.slice(0, 20)) {
            addEvidence(
              path,
              { type: "content_match", detail: `Contains matching keywords` },
              "discovery",
            );
          }
        } catch (err: any) {
          if (err?.code !== 1) {
            // 1 means no match, normal for grep
            limitations.push(
              `unified git grep failed: ${err?.message ?? "unknown error"}`,
            );
          }
        }
      }
    }
    pContentSearch.end();
  }

  // 10. Test proximity — discover and add as supporting evidence
  const nearbyTestCandidates: TaskContextResult["nearbyTestCandidates"] = [];
  const pTestDiscovery = perf.startPhase("testProximity");
  // Use a stable snapshot of candidatesMap keys (don't iterate over newly added test entries)
  const testDiscoverySources = [...candidatesMap.keys()].filter(
    (path) => getKind(path) !== "test",
  );
  for (const path of testDiscoverySources) {
    const tests = findNearbyTests(path, allFiles, allFileSet);
    if (tests.length > 0) {
      addEvidence(
        path,
        {
          type: "test_proximity",
          detail: `Has nearby tests: ${tests.join(", ")}`,
        },
        "supporting",
      );
      nearbyTestCandidates.push({ sourcePath: path, testPaths: tests });
      for (const t of tests) {
        addEvidence(
          t,
          { type: "test_proximity", detail: `Is test for: ${path}` },
          "supporting",
        );
      }
    }
  }
  pTestDiscovery.end();

  // 11. Initial assignment of confidence & sorting deterministically
  const intent = inferGoalIntent(
    input.goal,
    normalized.taskTypeSuggestion ?? "auto",
    Array.from(focusScope.exactFiles),
  );

  const assessments: CandidateAssessment[] = Array.from(
    candidatesMap.entries(),
  ).map(([path, evidence]) => {
    const kind = getKind(path);
    const confidence = inferConfidence(evidence);

    // Calcular score determinístico
    let score = 0;
    for (const e of evidence) {
      score += EVIDENCE_WEIGHTS[e.type as keyof typeof EVIDENCE_WEIGHTS] || 0;
    }
    score -= KIND_PENALTIES[kind] || 0;

    const explicitlyFocused = evidence.some((e) => e.type === "focus_path");

    // Elegibilidade
    let primaryEligible = isPrimaryEligibleKind(kind) || explicitlyFocused;
    if (kind === "test") primaryEligible = false;
    if (intent === "testing" && kind === "test") primaryEligible = true;
    if (intent === "configuration" && kind === "configuration")
      primaryEligible = true;

    // autoReadEligible logic
    let autoReadEligible = true;
    if (kind === "generated" || isLockFile(path)) {
      autoReadEligible = false;
    }
    if (explicitlyFocused) autoReadEligible = true;

    const eligibilityReasons: string[] = [];
    if (primaryEligible) eligibilityReasons.push("primary_eligible");
    if (!autoReadEligible) eligibilityReasons.push("auto_read_blocked");

    return {
      path,
      kind,
      evidence,
      score,
      confidence,
      primaryEligible,
      autoReadEligible,
      eligibilityReasons,
      rejectionReasons: [],
    };
  });

  // Sort candidates
  assessments.sort((a, b) => {
    // 1. score
    if (b.score !== a.score) return b.score - a.score;
    // 2. kind priority
    const kpA = candidateKindPriority(a.kind);
    const kpB = candidateKindPriority(b.kind);
    if (kpA !== kpB) return kpA - kpB;
    // 3. strong evidence count
    const strongA = a.evidence.filter(
      (e) => EVIDENCE_WEIGHTS[e.type as keyof typeof EVIDENCE_WEIGHTS] >= 35,
    ).length;
    const strongB = b.evidence.filter(
      (e) => EVIDENCE_WEIGHTS[e.type as keyof typeof EVIDENCE_WEIGHTS] >= 35,
    ).length;
    if (strongA !== strongB) return strongB - strongA;
    // 4. path
    return a.path.localeCompare(b.path);
  });

  const primaryFiles: TaskFileCandidate[] = [];
  const supportingFiles: TaskFileCandidate[] = [];
  for (const a of assessments) {
    const role: TaskFileRole =
      a.primaryEligible && a.confidence === "high"
        ? "primary"
        : a.kind === "test"
          ? "test"
          : "supporting";
    const recommendedReadTool =
      a.confidence === "high"
        ? "read"
        : a.confidence === "medium"
          ? "read_adaptive"
          : "read_many";
    const selectionReason = a.evidence.map((e) => e.type).join(", ");

    const candidate: TaskFileCandidate = {
      path: a.path,
      role,
      confidence: a.confidence,
      evidence: a.evidence,
      recommendedReadTool,
      selectionReason,
      autoReadEligible: a.autoReadEligible,
    };

    if (role === "primary") primaryFiles.push(candidate);
    else supportingFiles.push(candidate);
  }

  // 11.5 Extract code regions for primary files adaptively
  const depthConfig = {
    fast: { maxFiles: 1, maxRegions: 4 },
    balanced: { maxFiles: 2, maxRegions: 6 },
    deep: { maxFiles: 3, maxRegions: 8 },
  };
  const config = depthConfig[effectiveDepth];
  const regionTargets = primaryFiles
    .filter(
      (c) => c.confidence === "high" && isPrimaryEligibleKind(getKind(c.path)),
    )
    .slice(0, config.maxFiles);

  if (regionTargets.length > 0) {
    const pCodeRegions = perf.startPhase("codeRegions");
    const regionResults = await Promise.all(
      regionTargets.map((candidate) =>
        loadAndExtractCodeRegions({
          workspaceRoot: cwd,
          path: candidate.path,
          anchorKeywords,
          maxRegions: config.maxRegions,
        }).catch((err) => {
          if (!(err instanceof CodeRegionSkippedError)) {
            limitations.push(
              `Failed to extract code regions for ${candidate.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return null;
        }),
      ),
    );
    for (const result of regionResults) {
      if (!result) continue;
      const candidate = primaryFiles.find((f) => f.path === result.path);
      if (candidate && result.codeRegions.length > 0) {
        candidate.codeRegions = result.codeRegions;
      }
    }
    pCodeRegions.end();
  }

  // 12. Direct dependents — limited to top 3 primary files (skip eval/snapshot/generated/docs)
  let directDependents: TaskContextResult["directDependents"] = [];
  if (effectiveDepth !== "fast") {
    const pDependencySearch = perf.startPhase("dependencySearch");
    const primaryEligible = primaryFiles
      .slice(0, 3)
      .map((c) => c.path)
      .filter((p) => isPrimaryEligibleKind(getKind(p)));
    directDependents = await getLimitedSharedDependencies(cwd, primaryEligible);
    directDependents = directDependents
      .filter((entry) => !isPathExcluded(entry.source))
      .map((entry) => ({
        ...entry,
        dependents: entry.dependents.filter((path) => !isPathExcluded(path)),
      }))
      .filter((entry) => entry.dependents.length > 0);
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
    focusScope: {
      active: focusScope.active,
      exactFiles: [...focusScope.exactFiles],
      directories: focusScope.directoryPrefixes,
      matchedFileCount: discoveryFiles.length,
      unresolved: focusScope.unresolved,
    },
    primaryFiles,
    supportingFiles,
    riskProfile: calculateRiskProfile({
      taskType: normalized.taskTypeSuggestion ?? "auto",
      goalIntent: intent,
      effectiveDepth,
      focusScope: {
        active: focusScope.active,
        exactFiles: [...focusScope.exactFiles],
        directories: focusScope.directoryPrefixes,
        matchedFileCount: discoveryFiles.length,
        unresolved: focusScope.unresolved,
      },
      assessments,
      directDependents,
      nearbyTestCandidates,
    }),
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
  const finalResultWithSteps = enforceFinalContextBudget(
    result,
    maxTokens,
    anchorKeywords,
  );

  pBudget.end();
  return finalResultWithSteps;
}

// ─── Suggested next steps builder (runs after budget enforcement) ─────

// ─── Non-overlapping region selection ────────────────────────────────

function selectNonOverlappingRegions(
  regions: import("./types.js").CodeRegion[],
  maxRegions: number,
): import("./types.js").CodeRegion[] {
  const selected: import("./types.js").CodeRegion[] = [];
  for (const region of regions) {
    const overlaps = selected.some(
      (cur) =>
        region.startLine <= cur.endLine && region.endLine >= cur.startLine,
    );
    if (!overlaps) {
      selected.push(region);
    }
    if (selected.length >= maxRegions) break;
  }
  return selected;
}

function buildSuggestedNextSteps(
  result: TaskContextResult,
  anchorKeywords: string[],
): TaskContextResult["suggestedNextSteps"] {
  const steps: TaskContextResult["suggestedNextSteps"] = [];

  const readablePrimaryFiles = result.primaryFiles.filter(
    (c) => c.autoReadEligible !== false,
  );

  if (readablePrimaryFiles.length > 0) {
    const MAX_TOTAL_ITEMS = 5;
    const MAX_REGIONS_PER_FILE = 2;
    const allItems: Array<{
      path: string;
      startLine?: number;
      endLine?: number;
    }> = [];

    for (const c of readablePrimaryFiles.slice(0, MAX_TOTAL_ITEMS)) {
      if (allItems.length >= MAX_TOTAL_ITEMS) break;
      if (c.codeRegions && c.codeRegions.length > 0) {
        const nonOverlapping = selectNonOverlappingRegions(
          c.codeRegions,
          MAX_REGIONS_PER_FILE,
        );
        for (const r of nonOverlapping) {
          if (allItems.length >= MAX_TOTAL_ITEMS) break;
          allItems.push({
            path: c.path,
            startLine: r.startLine,
            endLine: r.endLine,
          });
        }
      } else {
        allItems.push({ path: c.path });
      }
    }

    steps.push({
      tool: "read_many",
      arguments: { items: allItems },
      reason:
        "Read the strongest implementation candidates and their relevant regions.",
    });
  } else {
    const fallbackCandidates = result.supportingFiles.filter(
      (c) => c.autoReadEligible !== false,
    );
    if (fallbackCandidates.length > 0) {
      steps.push({
        tool: "read_adaptive",
        arguments: { path: fallbackCandidates[0].path },
        reason:
          "No high-confidence primary file was found; inspect the strongest supporting candidate.",
      });
    } else {
      steps.push({
        tool: "grep",
        arguments: { pattern: anchorKeywords.slice(0, 3).join("|") },
        reason:
          "No reliable file candidate was found; search for the normalized goal terms.",
      });
    }
  }

  return steps;
}

// ─── Budget enforcement by real JSON size ─────────────────────────────

function enforceTaskContextBudget(
  result: TaskContextResult,
  maxTokens: number,
): TaskContextResult {
  const measureTokens = () => Math.ceil(JSON.stringify(result).length / 4);
  let currentTokens = measureTokens();

  let omittedCandidates = 0;
  let truncated = false;

  const estimateCandidateTokens = (c: any) =>
    Math.ceil(JSON.stringify(c).length / 4);

  let omittedRegions = 0;

  // Trim supporting files first (lowest priority), from the end (lowest confidence)
  while (currentTokens > maxTokens && result.supportingFiles.length > 0) {
    const popped = result.supportingFiles.pop();
    currentTokens -= estimateCandidateTokens(popped);
    omittedCandidates++;
    truncated = true;
  }

  // Trim regions from primary files from back to front before dropping files entirely
  if (currentTokens > maxTokens) {
    for (let i = result.primaryFiles.length - 1; i >= 0; i--) {
      if (currentTokens <= maxTokens) break;
      const file = result.primaryFiles[i];
      if (file.codeRegions && file.codeRegions.length > 0) {
        while (currentTokens > maxTokens && file.codeRegions.length > 0) {
          const regions = file.codeRegions;
          const oldFileTokens = estimateCandidateTokens(file);
          regions.pop();
          const newFileTokens = estimateCandidateTokens(file);
          currentTokens -= oldFileTokens - newFileTokens;
          omittedRegions++;
          truncated = true;
        }
        if (file.codeRegions.length === 0) {
          delete file.codeRegions;
        }
      }
    }
  }

  // Trim primary files only after all supporting and regions are gone, always keep at least 1
  while (currentTokens > maxTokens && result.primaryFiles.length > 1) {
    const popped = result.primaryFiles.pop();
    currentTokens -= estimateCandidateTokens(popped);
    omittedCandidates++;
    truncated = true;
  }

  if (truncated) {
    result.limitations.push(
      `Budget: omitted ${omittedCandidates} candidate(s) to stay within ${maxTokens} tokens.`,
    );

    // Clean up references to truncated files
    const retainedPaths = new Set([
      ...result.primaryFiles.map((file) => file.path),
      ...result.supportingFiles.map((file) => file.path),
    ]);

    result.directDependents = result.directDependents.filter((item) =>
      retainedPaths.has(item.source),
    );

    result.nearbyTestCandidates = result.nearbyTestCandidates
      .filter((item) => retainedPaths.has(item.sourcePath))
      .map((item) => ({
        ...item,
        testPaths: item.testPaths.filter((path) => retainedPaths.has(path)),
      }));
  }

  result.budget = {
    maxTokens,
    estimatedTokens: measureTokens(),
    truncated,
    omittedCandidates,
    omittedRegions,
  };

  return result;
}

// ─── Final budget enforcement (includes suggestedNextSteps in measurement) ──

function cleanDerivedStructures(result: TaskContextResult): void {
  const retainedPaths = new Set([
    ...result.primaryFiles.map((file) => file.path),
    ...result.supportingFiles.map((file) => file.path),
  ]);

  result.directDependents = result.directDependents.filter((item) =>
    retainedPaths.has(item.source),
  );

  result.nearbyTestCandidates = result.nearbyTestCandidates
    .filter((item) => retainedPaths.has(item.sourcePath))
    .map((item) => ({
      ...item,
      testPaths: item.testPaths.filter((path) => retainedPaths.has(path)),
    }));
}

function enforceFinalContextBudget(
  result: TaskContextResult,
  maxTokens: number,
  anchorKeywords: string[],
): TaskContextResult {
  const measureTokens = () => Math.ceil(JSON.stringify(result).length / 4);

  const initialOmitted = result.budget.omittedCandidates;

  let omittedCandidates = initialOmitted;
  let exactTokens = measureTokens();
  let finalLimitationAdded = false;

  // Helper: true if any primary file still has codeRegions that can be trimmed
  const hasCodeRegions = () =>
    result.primaryFiles.some((f) => (f.codeRegions?.length ?? 0) > 0);

  // Helper: remove the lowest-priority region across all primary files
  const removeLowestPriorityRegion = (): boolean => {
    for (let i = result.primaryFiles.length - 1; i >= 0; i--) {
      const file = result.primaryFiles[i];
      if (file.codeRegions && file.codeRegions.length > 0) {
        file.codeRegions.pop();
        if (result.budget.omittedRegions === undefined)
          result.budget.omittedRegions = 0;
        result.budget.omittedRegions++;
        if (file.codeRegions.length === 0) delete file.codeRegions;
        return true;
      }
    }
    return false;
  };

  while (
    exactTokens > maxTokens &&
    (hasCodeRegions() ||
      result.supportingFiles.length > 0 ||
      result.primaryFiles.length > 1)
  ) {
    if (!finalLimitationAdded) {
      result.limitations.push(
        "Budget: additional candidates omitted after rebuilding suggestedNextSteps.",
      );
      finalLimitationAdded = true;
    }

    let poppedSomething = false;

    if (result.supportingFiles.length > 0) {
      result.supportingFiles.pop();
      omittedCandidates++;
      poppedSomething = true;
    } else if (removeLowestPriorityRegion()) {
      poppedSomething = true;
    } else if (result.primaryFiles.length > 1) {
      result.primaryFiles.pop();
      omittedCandidates++;
      poppedSomething = true;
    }

    if (!poppedSomething) break; // Safe-guard: nothing left to trim

    cleanDerivedStructures(result);

    result.suggestedNextSteps = buildSuggestedNextSteps(result, anchorKeywords);

    exactTokens = measureTokens();
  }

  if (exactTokens > maxTokens) {
    result.limitations.push(
      "Minimum task context structure exceeds the requested token budget.",
    );
  }

  const actualTokens = measureTokens();

  result.budget = {
    maxTokens,
    estimatedTokens: actualTokens,
    truncated:
      result.budget.omittedCandidates > 0 ||
      omittedCandidates > 0 ||
      (result.budget.omittedRegions ?? 0) > 0 ||
      actualTokens > maxTokens,
    omittedCandidates,
    omittedRegions: result.budget.omittedRegions,
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
  perf?: PerformanceRecorder,
): Promise<ToolResponse> {
  const resolvedMaxTokens =
    input.maxTokens ?? TASK_CONTEXT_BUDGET.defaultTokens;

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
    perf,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}
