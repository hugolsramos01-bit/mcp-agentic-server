import { existsSync } from "node:fs";
import { join } from "node:path";
import { 
  VerificationEvidence, 
  ClassifiedCheck, 
  TaskType, 
  PackageManager,
  CandidateAssessment,
  DirectDependentEntry,
  RiskProfileInput
} from "./types.js";
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
  const { cwd, packageManager, changedPaths, goal, taskType, focusPaths, availableChecks } = options;
  const dependenciesInstalled = detectDependencyEnvironment(cwd, packageManager);

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
    const nearbyTests = await findNearbyTests(cwd, changedPaths);

    // Get dependents to calculate fan-out
    const dependentsResults = await getLimitedSharedDependencies(cwd, changedPaths);
    const directDependents = dependentsResults as DirectDependentEntry[];

    const riskInput: RiskProfileInput = {
      taskType: taskType || "chore",
      effectiveDepth: "balanced",
      focusScope: {
        active: focusPaths !== undefined && focusPaths.length > 0,
        matchedFileCount: changedPaths.length,
        rejectedFileCount: 0
      },
      assessments,
      directDependents,
      nearbyTestCandidates: nearbyTests
    };

    const riskProfile = calculateRiskProfile(riskInput);

    return {
      riskProfile,
      taskType: taskType || "chore",
      changedPaths,
      candidatePaths: [], // Candidates are mostly for discovery
      nearbyTests: nearbyTests.map(n => n.path),
      dependentPaths: Array.from(new Set(directDependents.flatMap((d) => d.dependents))),
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  // 2. Discovery route (no changedPaths, but goal exists)
  if (goal) {
    const ctx = await buildTaskContext({
      cwd,
      goal,
      taskType,
      focusPaths,
      budget: { 
        tokens: 100000,
        candidates: 20,
        dependencyDepth: "balanced"
      }
    });

    return {
      riskProfile: ctx.riskProfile,
      taskType: ctx.taskType,
      changedPaths: [],
      candidatePaths: ctx.candidates.map(c => c.path),
      nearbyTests: ctx.nearbyTests.map(t => t.path),
      dependentPaths: Array.from(new Set(ctx.directDependents.flatMap(d => d.dependents))),
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  // 3. No changes, no goal -> Return null so planner returns an empty plan with limitation
  return null;
}
