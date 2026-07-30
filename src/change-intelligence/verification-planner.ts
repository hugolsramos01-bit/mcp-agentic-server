import type { ClassifiedCheck } from "../check-classifier.js";
import type { RiskLevel, VerificationEvidence, VerificationPlan, VerificationRecommendation, VerificationStage } from "./types.js";

/**
 * Transforms a RiskProfile and task context into an advisory VerificationPlan.
 * It does not execute anything; it strictly selects, orders, and explains the chosen checks.
 */
export function planVerification(evidence: VerificationEvidence): VerificationPlan {
  const { riskProfile, environment, availableChecks, changedPaths } = evidence;

  // Rule: actual_changes wins over discovery candidates
  const basis = changedPaths.length > 0 ? "actual_changes" : "discovery";

  // Rule: mutatesWorkspace checks are excluded
  const safeChecks = availableChecks.filter(check => !check.mutatesWorkspace);

  // Determine policy level
  let policyLevel: RiskLevel = riskProfile.level;
  if (riskProfile.level === "low" && riskProfile.confidence === "low") {
    policyLevel = "medium";
  }

  const recommendations: VerificationRecommendation[] = [];
  const limitations: string[] = [];

  if (environment.dependenciesInstalled === false) {
    limitations.push("Project dependencies are not installed; recommended checks may not run until the workspace dependencies are prepared.");
  }

  // Find checks by tier
  const getChecksByTier = (tier: string) => safeChecks.filter(c => c.tier === tier);
  
  const staticChecks = getChecksByTier("static_analysis");
  const unitChecks = getChecksByTier("unit_tests");
  const generalChecks = getChecksByTier("general_tests");
  const buildChecks = getChecksByTier("build");
  const integrationChecks = getChecksByTier("integration_tests");
  const smokeChecks = getChecksByTier("smoke_tests");
  const e2eChecks = getChecksByTier("e2e_tests");

  // Helper to add a recommendation
  const recommend = (checks: ClassifiedCheck[], stage: VerificationStage, priority: "recommended" | "strongly_recommended", reason: string) => {
    for (const check of checks) {
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
      }
    }
  };

  // Build policy application
  let needsBuild = false;
  let needsSmoke = false;
  let needsE2e = false;

  switch (policyLevel) {
    case "low":
      // initial: typecheck or lint
      recommend(staticChecks, "initial", "recommended", "Cheap static validation before broader checks.");
      // after_initial_success: nearby tests if available
      if (evidence.nearbyTests.length > 0) {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Nearby tests detected; running related test suite.");
      }
      break;

    case "medium":
      recommend(staticChecks, "initial", "recommended", "Static validation required for medium risk.");
      if (evidence.nearbyTests.length > 0) {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Nearby tests detected; running test suite.");
      } else {
        recommend(unitChecks.length > 0 ? unitChecks : generalChecks, "after_initial_success", "recommended", "Medium risk warrants unit or general test coverage.");
      }
      break;

    case "high":
      recommend(staticChecks, "initial", "strongly_recommended", "High risk requires strict static analysis.");
      recommend(generalChecks.length > 0 ? generalChecks : integrationChecks, "after_initial_success", "strongly_recommended", "High risk warrants broad regression coverage.");
      needsBuild = true;
      if (smokeChecks.length > 0) {
        needsSmoke = true;
      }
      break;

    case "critical":
      recommend(staticChecks, "initial", "strongly_recommended", "Critical risk requires strict static analysis.");
      recommend([...generalChecks, ...integrationChecks], "after_initial_success", "strongly_recommended", "Critical risk demands full test suites.");
      needsBuild = true;
      needsSmoke = true;
      needsE2e = true;
      break;
  }

  if (needsBuild) {
    if (buildChecks.length > 0) {
      recommend(buildChecks, "after_initial_success", "strongly_recommended", "High fan-out or broad scope requires building the artifacts.");
    } else {
      limitations.push("No declared build check was found.");
    }
  }

  if (needsSmoke) {
    if (smokeChecks.length > 0) {
      recommend(smokeChecks, "before_release", "strongly_recommended", "Sensitive package configuration or critical risk is in scope.");
    }
  }

  if (needsE2e) {
    if (e2eChecks.length > 0) {
      recommend(e2eChecks, "before_release", "strongly_recommended", "Critical risk paths require end-to-end validation.");
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
    recommendations,
    limitations
  };
}
