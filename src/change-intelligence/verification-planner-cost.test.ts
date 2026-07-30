import { test } from "node:test";
import * as assert from "node:assert";
import { planVerification } from "./verification-planner.js";
import type { VerificationEvidence, RiskProfile } from "./types.js";
import type { ClassifiedCheck } from "../check-classifier.js";

function createMockProfile(level: any, confidence: any, factors: any[] = []): RiskProfile {
  return {
    version: 1,
    basis: "pre_budget",
    level,
    score: 50,
    confidence,
    factors,
    blastRadius: {
      primaryCandidates: 1,
      observedUniqueDirectDependents: 0,
      directDependentsLowerBound: 0,
      dependencyDataTruncated: false,
      estimatedAffectedFiles: 1,
      focusMatchedFiles: 1
    },
    coverage: {
      dependencyAnalysis: "available"
    }
  };
}

const mockChecks: ClassifiedCheck[] = [
  { script: "typecheck", command: "npm run typecheck", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "low" },
  { script: "lint", command: "npm run lint", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "low" },
  { script: "test", command: "npm run test", tier: "general_tests", reason: "", confidence: "medium", mutatesWorkspace: false, estimatedCost: "medium" },
  { script: "test:unit", command: "npm run test:unit", tier: "unit_tests", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "medium" },
  { script: "build", command: "npm run build", tier: "build", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
];

test("checks com custos diferentes -> low antes de medium/high", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("high", "high"),
    taskType: "feature",
    changedPaths: ["src/core.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: [
      { script: "expensive-static", command: "npm run es", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
      { script: "cheap-static", command: "npm run cs", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "low" },
    ],
    environment: { dependenciesInstalled: true }
  };
  
  const plan = planVerification(evidence);
  
  // They have the same confidence, but cheap-static has low cost (better), so it should be first.
  assert.strictEqual(plan.recommendations[0].script, "cheap-static");
  assert.strictEqual(plan.recommendations[1].script, "expensive-static");
});
