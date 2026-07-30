import { existsSync } from "node:fs";
import { join } from "node:path";
import { 
  VerificationEvidence, 
  TaskType, 
  CandidateAssessment,
  DirectDependentEntry,
  RiskProfileInput
} from "./types.js";
import type { ClassifiedCheck, PackageManager } from "../check-classifier.js";
import { buildTaskContext } from "./task-context.js";
import { classifyCandidateKind } from "./indexed-path.js";
import { findNearbyTests } from "./test-proximity.js";
import { getLimitedSharedDependencies } from "./file-dependencies-internal.js";
import { calculateRiskProfile } from "./risk-profile.js";

export interface BuildEvidenceOptions {
  cwd: string;
  packageManager: PackageManager;
  changedPaths?: string[];
  goal?: string;
  taskType?: TaskType;
  focusPaths?: string[];
  availableChecks: ClassifiedCheck[];
}

export function detectDependencyEnvironment(
  cwd: string,
  packageManager: PackageManager
): boolean | "unknown" {
  if (existsSync(join(cwd, "node_modules"))) {
    return true;
  }
  if (
    packageManager === "yarn" &&
    (existsSync(join(cwd, ".pnp.cjs")) || existsSync(join(cwd, ".pnp.js")))
  ) {
    return true;
  }
  return false;
}

export async function buildVerificationEvidence(
  options: BuildEvidenceOptions
): Promise<VerificationEvidence | null> {
  const { cwd, packageManager, goal, taskType, focusPaths, availableChecks } = options;
  const dependenciesInstalled = detectDependencyEnvironment(cwd, packageManager);

  // Normalize and deduplicate changed paths
  const changedPaths = [...new Set((options.changedPaths ?? [])
    .map(p => p.replace(/\\/g, "/").replace(/^\.\/+/, ""))
    .filter(Boolean))
  ].sort((a, b) => a.localeCompare(b));

  // 1. Explicit actual_changes route
  if (changedPaths && changedPaths.length > 0) {
    const assessments: CandidateAssessment[] = changedPaths.map((path) => ({
      path,
      kind: classifyCandidateKind(path),
      evidence: [
        {
          type: "focus_path",
          detail: "File is present in the actual change set",
        },
      ],
      score: 100,
      confidence: "high",
      primaryEligible: true,
      autoReadEligible: true,
      eligibilityReasons: ["actual_change"],
      rejectionReasons: [],
    }));

    // Find nearby tests manually for the changed source files
    const { git } = await import("../git.js");
    const lsFilesResult = await git(cwd, ["ls-files", "-z"]);
    const allTrackedFiles = lsFilesResult.stdout.split("\0").filter(Boolean);
    const fileSet: ReadonlySet<string> = new Set(allTrackedFiles);
    
    const nearbyTests = changedPaths.map(sourcePath => ({
      sourcePath,
      testPaths: findNearbyTests(sourcePath, allTrackedFiles, fileSet)
    })).filter(candidate => candidate.testPaths.length > 0);

    // Get dependents to calculate fan-out
    const dependentsResults = await getLimitedSharedDependencies(cwd, changedPaths);
    const directDependents = dependentsResults as DirectDependentEntry[];

    const riskInput: RiskProfileInput = {
      taskType: taskType || "auto",
      effectiveDepth: "balanced",
      focusScope: {
        active: focusPaths !== undefined && focusPaths.length > 0,
        matchedFileCount: changedPaths.length,
        exactFiles: [],
        directories: [],
        unresolved: []
      },
      assessments,
      directDependents,
      nearbyTestCandidates: nearbyTests
    };

    const riskProfile = calculateRiskProfile(riskInput);

    return {
      riskProfile,
      taskType: taskType || "auto",
      changedPaths,
      candidatePaths: [], // Candidates are mostly for discovery
      nearbyTests: nearbyTests.flatMap(n => n.testPaths),
      dependentPaths: Array.from(new Set(directDependents.flatMap((d) => d.dependents))),
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  // 2. Discovery route (no changedPaths, but goal exists)
  if (goal) {
    const taskContext = await buildTaskContext({
      type: taskType ?? "auto",
      focusPaths,
      maxTokens: 8192,
      depth: "balanced",
      workspaceId: "suggest-checks-discovery",
      allowedRoots: [cwd],
      goal: goal,
      cwd
    });

    return {
      riskProfile: taskContext.riskProfile,
      taskType: taskContext.taskType,
      changedPaths: [], // It's discovery based
      candidatePaths: [...taskContext.primaryFiles, ...taskContext.supportingFiles].map(f => f.path),
      nearbyTests: taskContext.nearbyTestCandidates.flatMap(n => n.testPaths),
      dependentPaths: Array.from(new Set(taskContext.directDependents.flatMap(d => d.dependents))),
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  // 3. No changes, no goal -> Return null so planner returns an empty plan with limitation
  return null;
}
