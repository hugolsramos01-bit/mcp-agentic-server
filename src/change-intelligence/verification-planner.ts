import { classifyCandidateKind } from "./indexed-path.js";
import type { ClassifiedCheck } from "../check-classifier.js";
import type { RiskLevel, VerificationEvidence, VerificationPlan, VerificationRecommendation, VerificationStage, CheckTier } from "./types.js";

const SCRIPT_PRIORITY = [
  "typecheck",
  "lint",
  "lint:check",
  "test:unit",
  "unit",
  "test",
  "test:integration",
  "build",
  "build:app",
  "smoke:package",
  "test:smoke",
  "smoke",
  "test:http",
  "test:e2e",
  "e2e",
];

const COST_PRIORITY = { low: 3, medium: 2, high: 1 };
const CONFIDENCE_PRIORITY = { high: 3, medium: 2, low: 1 };

function sortChecks(checks: ClassifiedCheck[]): ClassifiedCheck[] {
  return [...checks].sort((a, b) => {
    // 1. Confidence (higher is better)
    if (CONFIDENCE_PRIORITY[a.confidence] !== CONFIDENCE_PRIORITY[b.confidence]) {
      return CONFIDENCE_PRIORITY[b.confidence] - CONFIDENCE_PRIORITY[a.confidence];
    }
    // 2. Cost (lower is better, meaning higher priority number)
    if (COST_PRIORITY[a.estimatedCost] !== COST_PRIORITY[b.estimatedCost]) {
      return COST_PRIORITY[a.estimatedCost] - COST_PRIORITY[b.estimatedCost]; // high cost = 1, low cost = 3. 3-1 > 0
    }
    // 3. Known Preference
    const idxA = SCRIPT_PRIORITY.indexOf(a.script);
    const idxB = SCRIPT_PRIORITY.indexOf(b.script);
    if (idxA !== -1 && idxB !== -1 && idxA !== idxB) {
      return idxA - idxB;
    }
    if (idxA !== -1 && idxB === -1) return -1;
    if (idxB !== -1 && idxA === -1) return 1;

    // 4. Alphabetical fallback
    return a.script.localeCompare(b.script);
  });
}

/**
 * Transforms a RiskProfile and task context into an advisory VerificationPlan.
 * It does not execute anything; it strictly selects, orders, and explains the chosen checks.
 */
export function planVerification(evidence: VerificationEvidence): VerificationPlan {
  const { riskProfile, environment, availableChecks, changedPaths, candidatePaths } = evidence;

  // Rule: actual_changes wins over discovery candidates
  const basis = changedPaths.length > 0 ? "actual_changes" : "discovery";

  // Check for documentation-only changes
  const scopePaths = changedPaths.length > 0 ? changedPaths : candidatePaths;
  const documentationOnly = scopePaths.length > 0 && scopePaths.every(path => classifyCandidateKind(path) === "documentation");

  let policyLevel: RiskLevel = riskProfile.level;
  if (riskProfile.level === "low" && riskProfile.confidence === "low") {
    policyLevel = "medium";
  }

  if (documentationOnly) {
    return {
      version: 1,
      mode: "advisory",
      basis,
      riskLevel: riskProfile.level,
      riskConfidence: riskProfile.confidence,
      policyLevel: "low",
      recommendations: [],
      limitations: ["Only documentation files are in scope; no code verification checks were recommended."],
    };
  }

  // Rule: mutatesWorkspace checks are excluded
  const safeChecks = availableChecks.filter(check => !check.mutatesWorkspace);

  const recommendations: VerificationRecommendation[] = [];
  const limitations: string[] = [];

  if (environment.dependenciesInstalled === false) {
    limitations.push("Project dependencies are not installed; recommended checks may not run until the workspace dependencies are prepared.");
  }

  // Find checks by tier
  const getChecksByTier = (tier: string) => sortChecks(safeChecks.filter(c => c.tier === tier));
  
  const staticChecks = getChecksByTier("static_analysis");
  const unitChecks = getChecksByTier("unit_tests");
  const generalChecks = getChecksByTier("general_tests");
  const buildChecks = getChecksByTier("build");
  const integrationChecks = getChecksByTier("integration_tests");
  const smokeChecks = getChecksByTier("smoke_tests");
  const e2eChecks = getChecksByTier("e2e_tests");

  // Caps tracking
  const caps = {
    static_analysis: 2,
    test_checks: 2, // pool for unit/general
    build: 1,
    integration: 1,
    smoke: 1,
    e2e: 1
  };

  const currentCounts = {
    static_analysis: 0,
    test_checks: 0,
    build: 0,
    integration: 0,
    smoke: 0,
    e2e: 0
  };

  // Helper to add a recommendation
  const recommend = (checks: ClassifiedCheck[], stage: VerificationStage, priority: "recommended" | "strongly_recommended", reason: string, capKey: keyof typeof caps) => {
    for (const check of checks) {
      if (currentCounts[capKey] >= caps[capKey]) break;

      if (!recommendations.some(r => r.script === check.script)) {
        recommendations.push({
          script: check.script,
          command: check.command,
          tier: check.tier,
          stage,
          priority,
          reason,
          riskFactors: riskProfile.factors.map(f => f.code),
          estimatedCost: check.estimatedCost,
          confidence: check.confidence
        });
        currentCounts[capKey]++;
      }
    }
  };

  // Build policy application
  let needsBuild = false;
  let needsIntegration = false;
  let needsSmoke = false;
  let needsE2e = false;

  const sensitiveConfiguration = riskProfile.factors.some(f => f.code === "configuration_scope" && f.weight >= 40);

  switch (policyLevel) {
    case "low":
      recommend(staticChecks, "initial", "recommended", "Cheap static validation before broader checks.", "static_analysis");
      if (evidence.nearbyTests.length > 0) {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Nearby tests were discovered for the changed source files.", "test_checks");
      }
      break;

    case "medium":
      recommend(staticChecks, "initial", "recommended", "Static validation required for medium risk.", "static_analysis");
      if (evidence.nearbyTests.length > 0) {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Nearby tests were discovered for the changed source files.", "test_checks");
      } else {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Medium risk warrants unit or general test coverage.", "test_checks");
      }
      break;

    case "high":
      recommend(staticChecks, "initial", "strongly_recommended", "High risk requires strict static analysis.", "static_analysis");
      recommend(generalChecks.length > 0 ? generalChecks : unitChecks, "after_initial_success", "strongly_recommended", "High risk warrants broad regression coverage.", "test_checks");
      needsBuild = true;
      needsIntegration = true;
      if (sensitiveConfiguration) {
        needsSmoke = true;
      }
      break;

    case "critical":
      recommend(staticChecks, "initial", "strongly_recommended", "Critical risk requires strict static analysis.", "static_analysis");
      recommend(generalChecks.length > 0 ? generalChecks : unitChecks, "after_initial_success", "strongly_recommended", "Critical risk demands full test suites.", "test_checks");
      needsBuild = true;
      needsIntegration = true;
      needsE2e = true;
      if (sensitiveConfiguration) {
        needsSmoke = true;
      }
      break;
  }

  if (needsBuild) {
    if (buildChecks.length > 0) {
      recommend(buildChecks, "after_initial_success", "strongly_recommended", "High fan-out or broad scope requires building the artifacts.", "build");
    } else {
      limitations.push("No declared build check was found.");
    }
  }

  if (needsIntegration && integrationChecks.length > 0) {
    recommend(integrationChecks, "after_initial_success", "strongly_recommended", "Complex changes warrant integration validation.", "integration");
  }

  if (needsSmoke) {
    if (smokeChecks.length > 0) {
      recommend(smokeChecks, "before_release", "strongly_recommended", "Sensitive package configuration requires a smoke test before release.", "smoke");
    }
  }

  if (needsE2e) {
    if (e2eChecks.length > 0) {
      recommend(e2eChecks, "before_release", "strongly_recommended", "Critical risk paths require end-to-end validation.", "e2e");
    }
  }

  // Ensure deterministic order
  recommendations.sort((a, b) => {
    const stageOrder = { initial: 0, after_initial_success: 1, before_release: 2 };
    if (stageOrder[a.stage] !== stageOrder[b.stage]) {
      return stageOrder[a.stage] - stageOrder[b.stage];
    }
    return a.script.localeCompare(b.script);
  });

  return {
    version: 1,
    mode: "advisory",
    basis,
    riskLevel: riskProfile.level,
    riskConfidence: riskProfile.confidence,
    policyLevel,
    recommendations,
    limitations
  };
}
