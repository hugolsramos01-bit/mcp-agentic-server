import {
  RiskProfile,
  RiskFactor,
  RiskLevel,
  TaskContextResult,
  TaskFileCandidate,
} from "./types.js";
import { isLockFile, classifyCandidateKind } from "./indexed-path.js";

interface RiskInput {
  goal: string;
  taskType: string;
  primaryFiles: TaskFileCandidate[];
  directDependents: Array<{ source: string; dependents: string[] }>;
}

export function calculateRiskProfile(input: RiskInput): RiskProfile {
  const factors: RiskFactor[] = [];
  let score = 0;
  
  let totalDependents = 0;
  for (const group of input.directDependents) {
    totalDependents += group.dependents.length;
  }
  
  // 1. Fan-out Risk (Dependents)
  if (totalDependents >= 10) {
    factors.push({
      factor: "fan_out",
      description: "Changes affect a large number of dependent files (>= 10).",
      weight: 30,
    });
  } else if (totalDependents >= 3) {
    factors.push({
      factor: "fan_out",
      description: "Changes affect multiple dependent files.",
      weight: 15,
    });
  }

  // 2. Configuration & Lockfile Risk
  const hasConfigChanges = input.primaryFiles.some(
    (f) => classifyCandidateKind(f.path) === "configuration" || isLockFile(f.path)
  );
  if (hasConfigChanges) {
    factors.push({
      factor: "configuration_change",
      description: "Involves changes to configuration or lockfiles, which can break the build or dependencies.",
      weight: 40,
    });
  }

  // 3. Mass Refactor Risk
  if (input.primaryFiles.length > 5) {
    factors.push({
      factor: "mass_refactor",
      description: "Broad scope of primary files (> 5) suggests a mass refactor or large feature.",
      weight: 25,
    });
  }

  // 4. Broad Focus / Investigation
  if (input.taskType === "investigation") {
    factors.push({
      factor: "broad_focus",
      description: "Task is investigative in nature and may touch unknown surfaces.",
      weight: 10,
    });
  }
  
  for (const factor of factors) {
    score += factor.weight;
  }
  
  let level: RiskLevel = "low";
  if (score >= 60) {
    level = "critical";
  } else if (score >= 40) {
    level = "high";
  } else if (score >= 20) {
    level = "medium";
  }

  return {
    level,
    score,
    factors,
    blastRadius: {
      affectedFiles: input.primaryFiles.length,
      dependentsCount: totalDependents,
    },
  };
}
