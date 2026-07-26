import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join } from "node:path";
import { normalizeGoal } from "./goal-normalizer.js";
import { scoreConfidence } from "./evidence.js";
import { findNearbyTests } from "./test-proximity.js";
import { getLimitedSharedDependencies } from "./file-dependencies-internal.js";
import { TaskContextInput, TaskContextResult, TaskFileCandidate, EvidenceEntry, TaskFileRole } from "./types.js";
import { ToolResponse } from "../pi-tools.js";

const execFileAsync = promisify(execFile);

// Simple token estimator: length / 4 is a common heuristic
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKENS_PER_FILE_CANDIDATE = 150;
const TOKENS_BASE = 500; // goal, types, layout

export async function buildTaskContext(input: TaskContextInput): Promise<TaskContextResult> {
  const { cwd, allowedRoots, goal, type, focusPaths = [], maxTokens = 15000 } = input;
  
  // 1. Normalize goal
  const normalized = normalizeGoal(goal, type);
  
  // 2. Gather all tracked files
  let allFiles: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 10 * 1024 * 1024 });
    allFiles = stdout.split("\n").map(f => f.trim()).filter(f => f.length > 0);
  } catch {
    // fallback if not git
    allFiles = [];
  }

  // File Candidates Map: path -> evidence
  const candidatesMap = new Map<string, EvidenceEntry[]>();
  function addEvidence(path: string, ev: EvidenceEntry) {
    if (!candidatesMap.has(path)) candidatesMap.set(path, []);
    const existing = candidatesMap.get(path)!;
    if (!existing.some(e => e.type === ev.type && e.detail === ev.detail)) {
      existing.push(ev);
    }
  }

  // 3. Process explicit paths (focusPaths and extractedPaths)
  for (const fp of focusPaths) {
    addEvidence(fp, { type: "focus_path", detail: "Provided directly in request" });
  }
  for (const ep of normalized.extractedPaths) {
    // Only add if it exists in allFiles to prevent hallucinations, unless allFiles is empty (not git)
    if (allFiles.length === 0 || allFiles.includes(ep) || allFiles.some(f => f.endsWith(ep))) {
      const match = allFiles.find(f => f.endsWith(ep)) || ep;
      addEvidence(match, { type: "extracted_path", detail: "Extracted from goal text" });
    }
  }

  // 4. Filename / Route / Schema matches
  const { expandedKeywords } = normalized;
  if (allFiles.length > 0 && expandedKeywords.length > 0) {
    for (const file of allFiles) {
      const base = basename(file).toLowerCase();
      const dir = dirname(file).toLowerCase();
      
      for (const kw of expandedKeywords) {
        if (kw.length < 3) continue;
        
        // Exact basename match (without extension)
        const nameOnly = base.substring(0, base.lastIndexOf("."));
        if (nameOnly === kw) {
          addEvidence(file, { type: "filename_exact", detail: `Basename matches keyword: ${kw}` });
        } else if (base.includes(kw)) {
          addEvidence(file, { type: "filename_partial", detail: `Basename contains keyword: ${kw}` });
        }
        
        // Route match (if it's a web route and directory matches)
        if ((base === "page.tsx" || base === "route.ts" || base === "index.ts" || base === "index.js") && dir.includes(kw)) {
          addEvidence(file, { type: "route", detail: `Directory matches keyword: ${kw}` });
        }
        
        // Schema match
        if (base.includes("schema") && (base.includes(kw) || dir.includes(kw))) {
          addEvidence(file, { type: "schema", detail: `Schema matches keyword: ${kw}` });
        }
      }
    }
  }

  // 5. Content Grep (Lexical Search)
  try {
    for (const kw of expandedKeywords.slice(0, 5)) { // limit grep to top 5 keywords to save time
      if (kw.length < 4) continue;
      const { stdout } = await execFileAsync("git", ["grep", "-i", "-l", kw], { cwd, maxBuffer: 10 * 1024 * 1024 });
      const grepFiles = stdout.split("\n").map(f => f.trim()).filter(f => f.length > 0);
      for (const gf of grepFiles.slice(0, 20)) { // top 20 per kw
        addEvidence(gf, { type: "content_match", detail: `Contains keyword: ${kw}` });
      }
    }
  } catch {
    // ignore grep failures
  }

  // 6. Test Proximity & Build File Candidates
  const primaryCandidates: TaskFileCandidate[] = [];
  const supportingCandidates: TaskFileCandidate[] = [];
  const nearbyTestCandidates: Array<{ sourcePath: string; testPaths: string[] }> = [];
  
  for (const [path, evidences] of candidatesMap.entries()) {
    // find nearby tests
    const tests = await findNearbyTests(join(cwd, path), cwd);
    if (tests.length > 0) {
      addEvidence(path, { type: "test_proximity", detail: `Has nearby tests: ${tests.join(", ")}` });
      nearbyTestCandidates.push({ sourcePath: path, testPaths: tests });
      
      // Add evidence to the tests themselves
      for (const t of tests) {
        addEvidence(t, { type: "test_proximity", detail: `Is test for: ${path}` });
      }
    }
  }

  // Sort candidates by evidence types
  const allCandidates = Array.from(candidatesMap.entries()).map(([path, evidences]) => {
    const confidence = scoreConfidence(evidences);
    
    // Determine Role
    let role: TaskFileRole = "supporting";
    if (path.includes(".test.") || path.includes(".spec.") || path.includes("__tests__")) {
      role = "test";
    } else if (confidence === "high") {
      role = "primary";
    }

    // Determine tool
    let recommendedReadTool: "read" | "read_adaptive" | "read_many" = "read_many";
    if (confidence === "high") {
      recommendedReadTool = "read";
    } else if (confidence === "medium") {
      recommendedReadTool = "read_adaptive";
    }

    return {
      path,
      role,
      confidence,
      evidence: evidences,
      recommendedReadTool
    } as TaskFileCandidate;
  });

  // Split into primary/supporting and sort by confidence + path for determinism
  const confidenceScore = { high: 3, medium: 2, low: 1 };
  allCandidates.sort((a, b) => {
    if (confidenceScore[a.confidence] !== confidenceScore[b.confidence]) {
      return confidenceScore[b.confidence] - confidenceScore[a.confidence];
    }
    // more evidence count = better
    if (a.evidence.length !== b.evidence.length) {
      return b.evidence.length - a.evidence.length;
    }
    return a.path.localeCompare(b.path);
  });

  for (const c of allCandidates) {
    if (c.confidence === "high" || c.role === "primary" || c.role === "test") {
      primaryCandidates.push(c);
    } else {
      supportingCandidates.push(c);
    }
  }

  // 7. Direct Dependents (only for primary candidates to limit scope)
  const primaryPaths = primaryCandidates.map(c => c.path);
  const directDependents = await getLimitedSharedDependencies(cwd, primaryPaths);

  // 8. Applicable Instructions (mocked for now, will filter input.instructionFiles)
  const applicableInstructions = [];
  if (input.instructionFiles) {
    for (const inst of input.instructionFiles) {
      // simple filter based on extension or presence in path
      applicableInstructions.push({
        path: inst,
        scope: "workspace",
        reason: "Workspace instruction"
      });
    }
  }

  // 9. Budget Enforcement
  const result: TaskContextResult = {
    version: 1,
    goal: input.goal,
    taskType: normalized.taskTypeSuggestion,
    taskTypeSource: normalized.taskTypeSource,
    primaryFiles: primaryCandidates,
    supportingFiles: supportingCandidates,
    directDependents,
    applicableInstructions,
    nearbyTestCandidates,
    suggestedNextSteps: [
      {
        tool: "read_many",
        arguments: { paths: primaryCandidates.slice(0, 5).map(c => c.path) },
        reason: "Read the most confident primary candidates first to understand the implementation details."
      }
    ],
    limitations: [],
    budget: {
      maxTokens,
      estimatedTokens: 0,
      truncated: false,
      omittedCandidates: 0
    }
  };

  return enforceTaskContextBudget(result, maxTokens);
}

function enforceTaskContextBudget(result: TaskContextResult, maxTokens: number): TaskContextResult {
  let estimatedTokens = TOKENS_BASE;
  let truncated = false;
  let omittedCandidates = 0;

  // We must always keep the basic structure. We start trimming supporting files, then primary files if absolutely necessary.
  
  const trimmedSupporting: TaskFileCandidate[] = [];
  for (const c of result.supportingFiles) {
    if (estimatedTokens + TOKENS_PER_FILE_CANDIDATE > maxTokens) {
      truncated = true;
      omittedCandidates++;
    } else {
      trimmedSupporting.push(c);
      estimatedTokens += TOKENS_PER_FILE_CANDIDATE;
    }
  }
  result.supportingFiles = trimmedSupporting;

  // If we still exceeded just by primary, we'd trim primary, but ideally we don't.
  const trimmedPrimary: TaskFileCandidate[] = [];
  for (const c of result.primaryFiles) {
    if (estimatedTokens + TOKENS_PER_FILE_CANDIDATE > maxTokens && trimmedPrimary.length > 0) {
      // Always keep at least 1 primary if possible
      truncated = true;
      omittedCandidates++;
    } else {
      trimmedPrimary.push(c);
      estimatedTokens += TOKENS_PER_FILE_CANDIDATE;
    }
  }
  result.primaryFiles = trimmedPrimary;

  result.budget = {
    maxTokens,
    estimatedTokens,
    truncated,
    omittedCandidates
  };

  if (truncated) {
    result.limitations.push(`Truncated ${omittedCandidates} file candidates to stay within the budget of ${maxTokens} tokens.`);
  }

  return result;
}

export async function taskContextTool(cwd: string, allowedRoots: string[], input: { goal: string; focusPaths?: string[]; excludePaths?: string[] }): Promise<ToolResponse> {
  const result = await buildTaskContext({
    cwd,
    allowedRoots,
    goal: input.goal,
    focusPaths: input.focusPaths,
    excludePaths: input.excludePaths,
    maxTokens: 15000, // Safe default for agentic
  });
  
  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2)
    }],
    structuredContent: result,
  };
}
