import {
  RiskProfile,
  RiskFactor,
  RiskLevel,
  RiskAssessmentConfidence,
  RiskFactorCode,
  RiskProfileInput,
  DirectDependentEntry,
} from "./types.js";
import { isLockFile } from "./indexed-path.js";

const FACTOR_ORDER: readonly RiskFactorCode[] = [
  "configuration_scope",
  "fan_out",
  "broad_focus",
  "multi_primary_scope",
  "refactor_scope",
  "test_proximity_gap",
];

function resolveDependencyCoverage(
  input: RiskProfileInput,
  primaryCount: number
): "not_run" | "unavailable" | "partial" | "available" {
  if (input.effectiveDepth === "fast") {
    return "not_run";
  }

  const failed = input.directDependents.filter(
    (entry) => entry.analysisStatus === "failed" || entry.analysisStatus === "skipped"
  ).length;

  if (input.directDependents.length > 0 && failed === input.directDependents.length) {
    return "unavailable";
  }

  if (
    failed > 0 ||
    input.directDependents.some((entry) => entry.truncated) ||
    primaryCount > 3
  ) {
    return "partial";
  }

  return "available";
}

function inferAssessmentConfidence(coverage: "not_run" | "unavailable" | "partial" | "available"): RiskAssessmentConfidence {
  if (coverage === "not_run" || coverage === "unavailable") {
    return "low";
  }
  if (coverage === "partial") {
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

function isSensitiveConfigPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === "package.json" ||
    normalized === "server.json" ||
    normalized.startsWith(".github/workflows/") ||
    isLockFile(normalized)
  );
}

export function calculateRiskProfile(input: RiskProfileInput): RiskProfile {
  const factors: RiskFactor[] = [];
  
  const primaryAssessments = input.assessments.filter(
    (c) => c.primaryEligible && c.confidence === "high"
  );

  const primaryPaths = new Set(primaryAssessments.map((c) => c.path));
  
  const dependentPaths = collectUniqueDependents(input.directDependents);
  
  // 1. configuration_scope
  let hasCommonConfig = false;
  let hasSensitiveConfig = false;
  
  const configPaths = primaryAssessments
    .filter((c) => c.kind === "configuration" || isSensitiveConfigPath(c.path))
    .map((c) => c.path);
    
  for (const path of configPaths) {
    if (isSensitiveConfigPath(path)) {
      hasSensitiveConfig = true;
    } else {
      hasCommonConfig = true;
    }
  }

  const configEvidencePaths = [...new Set(configPaths)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);

  if (hasSensitiveConfig) {
    factors.push({
      code: "configuration_scope",
      weight: 40,
      reason: "Involves sensitive configuration or lockfiles.",
      evidence: { paths: configEvidencePaths },
    });
  } else if (hasCommonConfig) {
    factors.push({
      code: "configuration_scope",
      weight: 20,
      reason: "Involves common configuration files.",
      evidence: { paths: configEvidencePaths },
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
  if (input.focusScope.active) {
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
  }

  // 5. test_proximity_gap
  const sourcePaths = primaryAssessments
    .filter((c) => c.kind === "source")
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
  const observedUniqueDependents = dependentPaths.size;
  const largestReportedFanOut = Math.max(
    0,
    ...input.directDependents.map((entry) => entry.totalDependents)
  );
  const fanOutForScoring = Math.max(observedUniqueDependents, largestReportedFanOut);

  if (fanOutForScoring > 10) {
    factors.push({
      code: "fan_out",
      weight: 45,
      reason: "More than 10 unique dependent files.",
      evidence: { count: fanOutForScoring },
    });
  } else if (fanOutForScoring >= 6) {
    factors.push({
      code: "fan_out",
      weight: 25,
      reason: "6 to 10 unique dependent files.",
      evidence: { count: fanOutForScoring },
    });
  } else if (fanOutForScoring >= 3) {
    factors.push({
      code: "fan_out",
      weight: 10,
      reason: "3 to 5 unique dependent files.",
      evidence: { count: fanOutForScoring },
    });
  }

  // Sort deterministically
  factors.sort((a, b) => FACTOR_ORDER.indexOf(a.code) - FACTOR_ORDER.indexOf(b.code));

  // Score
  const score = Math.min(100, factors.reduce((total, factor) => total + factor.weight, 0));
  
  const coverageAnalysis = resolveDependencyCoverage(input, primaryCount);

  return {
    version: 1,
    basis: "pre_budget",
    level: riskLevelFromScore(score),
    score,
    confidence: inferAssessmentConfidence(coverageAnalysis),
    factors,
    blastRadius: {
      primaryCandidates: primaryPaths.size,
      observedUniqueDirectDependents: observedUniqueDependents,
      directDependentsLowerBound: fanOutForScoring,
      dependencyDataTruncated: input.directDependents.some((e) => e.truncated),
      estimatedAffectedFiles: new Set([...primaryPaths, ...dependentPaths]).size,
      focusMatchedFiles: input.focusScope.matchedFileCount,
    },
    coverage: {
      dependencyAnalysis: coverageAnalysis,
    },
  };
}
