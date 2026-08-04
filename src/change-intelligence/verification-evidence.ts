import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  VerificationEvidence,
  TaskType,
  CandidateAssessment,
  DirectDependentEntry,
  RiskProfileInput,
} from "./types.js";
import type { ClassifiedCheck, PackageManager } from "../check-classifier.js";
import { buildTaskContext } from "./task-context.js";
import { classifyCandidateKind, isLockFile } from "./indexed-path.js";
import { normalizeGoal } from "./goal-normalizer.js";
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
  gitMetadataAvailable?: boolean;
  availableChecks: ClassifiedCheck[];
}

const DOMAIN_PATTERNS: Array<[string, RegExp]> = [
  [
    "concurrency",
    /(?:^|[^a-z0-9])(lease|lock|locking|mutex|concurr(?:ency|ent)?|fencing|semaphore)(?:[^a-z0-9]|$)/i,
  ],
  [
    "transaction",
    /(?:^|[^a-z0-9])(transaction|transactional|transacao|rollback|commit)(?:[^a-z0-9]|$)/i,
  ],
  [
    "authentication",
    /(?:^|[^a-z0-9])(auth|authentication|autenticacao|oauth|jwt|login)(?:[^a-z0-9]|$)/i,
  ],
  [
    "migration",
    /(?:^|[^a-z0-9])(migration|migrate|migracao|schema-change)(?:[^a-z0-9]|$)/i,
  ],
];

function normalizeFocusedPaths(cwd: string, paths: string[] = []): string[] {
  const normalized = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (!path || isAbsolute(path) || path.split("/").includes("..")) continue;
    if (!existsSync(join(cwd, path))) continue;
    normalized.add(path);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b));
}

export function detectVerificationDomains(
  goal: string | undefined,
  paths: readonly string[],
): string[] {
  const domainPaths = paths.filter((path) => !isLockFile(path));
  const searchable = [goal ?? "", ...domainPaths].join(" ");
  return DOMAIN_PATTERNS
    .filter(([, pattern]) => pattern.test(searchable))
    .map(([domain]) => domain);
}

export function detectDependencyEnvironment(
  cwd: string,
  packageManager: PackageManager,
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
  options: BuildEvidenceOptions,
): Promise<VerificationEvidence | null> {
  const {
    cwd,
    packageManager,
    goal,
    taskType,
    focusPaths,
    availableChecks,
  } = options;
  const normalizedGoal = goal ? normalizeGoal(goal, taskType) : undefined;
  const effectiveTaskType =
    taskType ?? normalizedGoal?.taskTypeSuggestion ?? "auto";
  const dependenciesInstalled = detectDependencyEnvironment(cwd, packageManager);
  const normalizedFocusPaths = normalizeFocusedPaths(cwd, focusPaths);
  const evidenceLimitations: string[] = [];

  if (options.gitMetadataAvailable === false) {
    evidenceLimitations.push(
      "Git metadata unavailable; plan derived from goal and focused paths.",
    );
  }

  const changedPaths = [
    ...new Set(
      (options.changedPaths ?? [])
        .map((path) => path.replace(/\\/g, "/").replace(/^\.\/+/, ""))
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (changedPaths.length > 0) {
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

    let allTrackedFiles = [...new Set([...changedPaths, ...normalizedFocusPaths])];
    try {
      const { git } = await import("../git.js");
      const lsFilesResult = await git(cwd, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      allTrackedFiles = lsFilesResult.stdout.split("\0").filter(Boolean);
    } catch {
      if (
        !evidenceLimitations.some((item) =>
          item.startsWith("Git metadata unavailable"),
        )
      ) {
        evidenceLimitations.push(
          "Git metadata unavailable; verification evidence is limited to provided paths.",
        );
      }
    }
    const fileSet: ReadonlySet<string> = new Set(allTrackedFiles);

    const nearbyTestCandidates = changedPaths
      .map((sourcePath) => ({
        sourcePath,
        testPaths: findNearbyTests(sourcePath, allTrackedFiles, fileSet),
      }))
      .filter((candidate) => candidate.testPaths.length > 0);
    const focusedTests = normalizedFocusPaths.filter(
      (path) => classifyCandidateKind(path) === "test",
    );
    const nearbyTests = [
      ...new Set([
        ...nearbyTestCandidates.flatMap((candidate) => candidate.testPaths),
        ...focusedTests,
      ]),
    ].sort((a, b) => a.localeCompare(b));

    let directDependents: DirectDependentEntry[] = [];
    try {
      directDependents = (await getLimitedSharedDependencies(
        cwd,
        changedPaths,
      )) as DirectDependentEntry[];
    } catch {
      evidenceLimitations.push(
        "Dependency relationships could not be resolved for the provided change set.",
      );
    }

    const riskInput: RiskProfileInput = {
      taskType: effectiveTaskType,
      effectiveDepth: "balanced",
      focusScope: {
        active: false,
        matchedFileCount: changedPaths.length,
        exactFiles: [],
        directories: [],
        unresolved: [],
      },
      assessments,
      directDependents,
      nearbyTestCandidates,
    };

    const riskProfile = calculateRiskProfile(riskInput);

    return {
      basis: "actual_changes",
      riskProfile,
      taskType: effectiveTaskType,
      changedPaths,
      candidatePaths: [],
      nearbyTests,
      dependentPaths: Array.from(
        new Set(directDependents.flatMap((entry) => entry.dependents)),
      ),
      focusPaths: normalizedFocusPaths,
      domainSignals: detectVerificationDomains(goal, [
        ...changedPaths,
        ...normalizedFocusPaths,
      ]),
      limitations: evidenceLimitations,
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  if (goal && options.gitMetadataAvailable === false) {
    const assessments: CandidateAssessment[] = normalizedFocusPaths.map((path) => ({
      path,
      kind: classifyCandidateKind(path),
      evidence: [
        {
          type: "focus_path",
          detail: "File was explicitly provided for goal-based verification",
        },
      ],
      score: 90,
      confidence: "high",
      primaryEligible: true,
      autoReadEligible: true,
      eligibilityReasons: ["goal_focus"],
      rejectionReasons: [],
    }));
    const focusedTests = normalizedFocusPaths.filter(
      (path) => classifyCandidateKind(path) === "test",
    );
    const riskProfile = calculateRiskProfile({
      taskType: effectiveTaskType,
      effectiveDepth: "balanced",
      focusScope: {
        active: normalizedFocusPaths.length > 0,
        matchedFileCount: normalizedFocusPaths.length,
        exactFiles: normalizedFocusPaths,
        directories: [],
        unresolved: [],
      },
      assessments,
      directDependents: [],
      nearbyTestCandidates: [],
    });

    if (normalizedFocusPaths.length === 0) {
      evidenceLimitations.push(
        "No focused paths were available; risk was estimated from the goal only.",
      );
    }

    return {
      basis: "goal_discovery",
      riskProfile,
      taskType: effectiveTaskType,
      changedPaths: [],
      candidatePaths: normalizedFocusPaths,
      nearbyTests: focusedTests,
      dependentPaths: [],
      focusPaths: normalizedFocusPaths,
      domainSignals: detectVerificationDomains(goal, normalizedFocusPaths),
      limitations: evidenceLimitations,
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  if (goal) {
    const taskContext = await buildTaskContext({
      type: effectiveTaskType,
      focusPaths,
      maxTokens: 8192,
      depth: "balanced",
      workspaceId: "suggest-checks-discovery",
      allowedRoots: [cwd],
      goal,
      cwd,
    });

    const discoveredCandidates = [
      ...taskContext.primaryFiles,
      ...taskContext.supportingFiles,
    ].map((file) => file.path);
    const focusedTests = normalizedFocusPaths.filter(
      (path) => classifyCandidateKind(path) === "test",
    );
    const candidatePaths = [
      ...new Set([...discoveredCandidates, ...normalizedFocusPaths]),
    ].sort((a, b) => a.localeCompare(b));
    const nearbyTests = [
      ...new Set([
        ...taskContext.nearbyTestCandidates.flatMap(
          (candidate) => candidate.testPaths,
        ),
        ...focusedTests,
      ]),
    ].sort((a, b) => a.localeCompare(b));

    return {
      basis: "goal_discovery",
      riskProfile: taskContext.riskProfile,
      taskType: taskContext.taskType,
      changedPaths: [],
      candidatePaths,
      nearbyTests,
      dependentPaths: Array.from(
        new Set(taskContext.directDependents.flatMap((entry) => entry.dependents)),
      ),
      focusPaths: normalizedFocusPaths,
      domainSignals: detectVerificationDomains(goal, candidatePaths),
      limitations: evidenceLimitations,
      availableChecks,
      environment: {
        dependenciesInstalled,
      },
    };
  }

  return null;
}
