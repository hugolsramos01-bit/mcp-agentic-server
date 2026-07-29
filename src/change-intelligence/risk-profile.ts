import {
  RiskProfile,
  RiskFactor,
  RiskLevel,
  RiskAssessmentConfidence,
  RiskFactorCode,
  RiskProfileInput,
  DirectDependentEntry,
} from "./types.js";
import { isLockFile, classifyCandidateKind } from "./indexed-path.js";

const FACTOR_ORDER: readonly RiskFactorCode[] = [
  "configuration_scope",
  "fan_out",
  "broad_focus",
  "multi_primary_scope",
  "refactor_scope",
  "test_proximity_gap",
];

function inferAssessmentConfidence(input: RiskProfileInput): RiskAssessmentConfidence {
  if (input.effectiveDepth === "fast") {
    return "low";
  }

  const primaryCount = input.assessments.filter(
    (candidate) => candidate.primaryEligible && candidate.confidence === "high"
  ).length;

  if (primaryCount > 3) {
    return "medium";
  }

  return "high";
}

function collectUniqueDependents(entries: readonly DirectDependentEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => entry.dependents));
}

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 70) return "critical";
  if (score >= 40) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function calculateRiskProfile(input: RiskProfileInput): RiskProfile {
  const factors: RiskFactor[] = [];
  
  const primaryPaths = new Set(
    input.assessments
      .filter((c) => c.primaryEligible && c.confidence === "high")
      .map((c) => c.path)
  );
  
  const dependentPaths = collectUniqueDependents(input.directDependents);
  
  // 1. configuration_scope
  let hasCommonConfig = false;
  let hasSensitiveConfig = false;
  
  const configPaths = input.assessments
    .filter((c) => c.primaryEligible && (c.kind === "configuration" || isLockFile(c.path)))
    .map((c) => c.path);
    
  for (const path of configPaths) {
    if (isLockFile(path)) {
      hasSensitiveConfig = true;
    } else if (
      path === "package.json" || 
      path === "server.json" || 
      path.startsWith(".github/workflows/") ||
      path.startsWith(".github\\workflows\\")
    ) {
      hasSensitiveConfig = true;
    } else {
      hasCommonConfig = true;
    }
  }

  if (hasSensitiveConfig) {
    factors.push({
      code: "configuration_scope",
      weight: 40,
      reason: "Involves sensitive configuration or lockfiles.",
      evidence: { paths: configPaths.slice(0, 3).sort() },
    });
  } else if (hasCommonConfig) {
    factors.push({
      code: "configuration_scope",
      weight: 15,
      reason: "Involves common configuration files.",
      evidence: { paths: configPaths.slice(0, 3).sort() },
    });
  }

  // 2. multi_primary_scope
  const primaryCount = primaryPaths.size;
  if (primaryCount > 5) {
    factors.push({
      code: "multi_primary_scope",
      weight: 20,
      reason: "More than 5 primary candidates identified.",
      evidence: { count: primaryCount },
    });
  } else if (primaryCount >= 3) {
    factors.push({
      code: "multi_primary_scope",
      weight: 10,
      reason: "3 to 5 primary candidates identified.",
      evidence: { count: primaryCount },
    });
  }

  // 3. refactor_scope
  if (input.taskType === "refactor" && primaryCount >= 3) {
    factors.push({
      code: "refactor_scope",
      weight: 20,
      reason: "Refactor task affecting multiple primary files.",
      evidence: { count: primaryCount },
    });
  }

  // 4. broad_focus
  const matched = input.focusScope.matchedFileCount;
  if (matched > 100) {
    factors.push({
      code: "broad_focus",
      weight: 30,
      reason: "Focus scope matches more than 100 files.",
      evidence: { count: matched },
    });
  } else if (matched > 20) {
    factors.push({
      code: "broad_focus",
      weight: 15,
      reason: "Focus scope matches more than 20 files.",
      evidence: { count: matched },
    });
  }

  // 5. test_proximity_gap
  const sourcePaths = input.assessments
    .filter((c) => c.primaryEligible && c.kind === "source")
    .map((c) => c.path);
    
  let hasMissingProximity = false;
  for (const src of sourcePaths) {
    const hasNearby = input.nearbyTestCandidates.some((t) => t.sourcePath === src);
    if (!hasNearby) {
      hasMissingProximity = true;
      break;
    }
  }
  
  if (hasMissingProximity) {
    factors.push({
      code: "test_proximity_gap",
      weight: 10,
      reason: "Some primary source files lack nearby test evidence.",
    });
  }

  // 6. fan_out
  const depsCount = dependentPaths.size;
  if (depsCount > 10) {
    factors.push({
      code: "fan_out",
      weight: 45,
      reason: "More than 10 unique dependent files.",
      evidence: { count: depsCount },
    });
  } else if (depsCount >= 6) {
    factors.push({
      code: "fan_out",
      weight: 25,
      reason: "6 to 10 unique dependent files.",
      evidence: { count: depsCount },
    });
  } else if (depsCount >= 3) {
    factors.push({
      code: "fan_out",
      weight: 10,
      reason: "3 to 5 unique dependent files.",
      evidence: { count: depsCount },
    });
  }

  // Sort deterministically
  factors.sort((a, b) => FACTOR_ORDER.indexOf(a.code) - FACTOR_ORDER.indexOf(b.code));

  // Score
  const score = Math.min(100, factors.reduce((total, factor) => total + factor.weight, 0));
  
  let dependencyAnalysis: "not_run" | "partial" | "available" = "available";
  if (input.effectiveDepth === "fast") {
    dependencyAnalysis = "not_run";
  } else if (primaryCount > 3) {
    dependencyAnalysis = "partial";
  }

  return {
    version: 1,
    basis: "pre_budget",
    level: riskLevelFromScore(score),
    score,
    confidence: inferAssessmentConfidence(input),
    factors,
    blastRadius: {
      primaryCandidates: primaryPaths.size,
      uniqueDirectDependents: depsCount,
      estimatedAffectedFiles: new Set([...primaryPaths, ...dependentPaths]).size,
      focusMatchedFiles: matched,
    },
    coverage: {
      dependencyAnalysis,
    },
  };
}
