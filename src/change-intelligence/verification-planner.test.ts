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
  { script: "lint:fix", command: "npm run lint:fix", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: true, estimatedCost: "low" },
  { script: "test", command: "npm run test", tier: "general_tests", reason: "", confidence: "medium", mutatesWorkspace: false, estimatedCost: "medium" },
  { script: "test:unit", command: "npm run test:unit", tier: "unit_tests", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "medium" },
  { script: "test:integration", command: "npm run test:integration", tier: "integration_tests", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
  { script: "build", command: "npm run build", tier: "build", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
  { script: "smoke:package", command: "npm run smoke:package", tier: "smoke_tests", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "low" },
  { script: "e2e", command: "npm run e2e", tier: "e2e_tests", reason: "", confidence: "medium", mutatesWorkspace: false, estimatedCost: "high" },
];

test("Um source isolado, risco low e teste próximo não recomenda build", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("low", "high"),
    taskType: "feature",
    changedPaths: ["src/feature.ts"],
    candidatePaths: [],
    nearbyTests: ["src/feature.test.ts"],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  assert.strictEqual(plan.basis, "actual_changes");
  assert.deepStrictEqual(plan.recommendations.map(r => r.script), ["lint", "typecheck", "test:unit"]); // Unit tests because nearby tests
  assert.strictEqual(plan.recommendations.every(r => r.script !== "build"), true);
});

test("Risco high por fan-out recomenda static analysis, testes e build", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("high", "high", [{ code: "fan_out", reason: "", weight: 60 }]),
    taskType: "feature",
    changedPaths: ["src/core.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  
  const recommendedScripts = plan.recommendations.map(r => r.script);
  assert.ok(recommendedScripts.includes("typecheck"));
  assert.ok(recommendedScripts.includes("test"));
  assert.ok(recommendedScripts.includes("build"));
});

test("Configuração sensível critical recomenda smoke/package antes de release", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("critical", "high", [{ code: "configuration_scope", reason: "", weight: 40 }]),
    taskType: "configuration",
    changedPaths: ["package.json"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  
  const smokeRecc = plan.recommendations.find(r => r.script === "smoke:package");
  assert.ok(smokeRecc);
  assert.strictEqual(smokeRecc?.stage, "before_release");
});

test("Critical risk without sensitive configuration does not recommend smoke tests automatically", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("critical", "high", []),
    taskType: "feature",
    changedPaths: ["src/critical-file.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  
  const smokeRecc = plan.recommendations.find(r => r.script === "smoke:package");
  assert.strictEqual(smokeRecc, undefined);
});

test("Documentation-only changes produce empty plan with low policy level", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("critical", "high"),
    taskType: "docs",
    changedPaths: ["README.md", "docs/architecture.md"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  
  assert.strictEqual(plan.policyLevel, "low");
  assert.strictEqual(plan.recommendations.length, 0);
  assert.ok(plan.limitations.some(l => l.includes("Only documentation files are in scope")));
});

test("Limits multiple checks of the same tier", () => {
  const extraStaticChecks: ClassifiedCheck[] = [
    ...mockChecks,
    { script: "stylelint", command: "npm run stylelint", tier: "static_analysis", reason: "", confidence: "medium", mutatesWorkspace: false, estimatedCost: "low" },
    { script: "format:check", command: "npm run format:check", tier: "static_analysis", reason: "", confidence: "low", mutatesWorkspace: false, estimatedCost: "low" },
  ];
  
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("high", "high"),
    taskType: "feature",
    changedPaths: ["src/core.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: extraStaticChecks,
    environment: { dependenciesInstalled: true }
  };
  
  const plan = planVerification(evidence);
  const staticCount = plan.recommendations.filter(r => r.tier === "static_analysis").length;
  assert.strictEqual(staticCount, 2); // Max 2 static analyses
});

test("level: low com confidence: low usa política medium sem alterar o nível original", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("low", "low"),
    taskType: "feature",
    changedPaths: ["src/some.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  assert.strictEqual(plan.riskLevel, "low"); // Unchanged
  
  // Medium policy without nearby tests recommends unit tests / general tests by default
  const recommendedScripts = plan.recommendations.map(r => r.script);
  assert.ok(recommendedScripts.includes("test:unit"));
});

test("Checks mutantes nunca aparecem", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("critical", "high"),
    taskType: "feature",
    changedPaths: ["src/some.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks, // contains lint:fix
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  assert.strictEqual(plan.recommendations.map(r => r.script).includes("lint:fix"), false);
});

test("Scripts inexistentes nunca são inventados (No build check)", () => {
  const withoutBuild = mockChecks.filter(c => c.script !== "build");
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("high", "high"),
    taskType: "feature",
    changedPaths: ["src/some.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: withoutBuild,
    environment: { dependenciesInstalled: true }
  };
  const plan = planVerification(evidence);
  assert.strictEqual(plan.recommendations.map(r => r.script).includes("build"), false);
  assert.ok(plan.limitations.includes("No declared build check was found."));
});

test("Entradas em ordem diferente produzem plano idêntico (Determinismo)", () => {
  const evidence1: VerificationEvidence = {
    riskProfile: createMockProfile("medium", "high"),
    taskType: "feature",
    changedPaths: ["src/some.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: [...mockChecks].reverse(),
    environment: { dependenciesInstalled: true }
  };
  const plan1 = planVerification(evidence1);

  const evidence2: VerificationEvidence = {
    ...evidence1,
    availableChecks: [...mockChecks].sort(() => Math.random() - 0.5)
  };
  const plan2 = planVerification(evidence2);
  
  assert.deepStrictEqual(plan1.recommendations, plan2.recommendations);
});

test("actual_changes vence candidatos da descoberta", () => {
  const evidenceDiscovery: VerificationEvidence = {
    riskProfile: createMockProfile("low", "high"),
    taskType: "feature",
    changedPaths: [],
    candidatePaths: ["src/foo.ts"],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  assert.strictEqual(planVerification(evidenceDiscovery).basis, "discovery");

  const evidenceActual: VerificationEvidence = {
    riskProfile: createMockProfile("low", "high"),
    taskType: "feature",
    changedPaths: ["src/foo.ts"],
    candidatePaths: ["src/foo.ts"],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: true }
  };
  assert.strictEqual(planVerification(evidenceActual).basis, "actual_changes");
});

test("Dependências ausentes geram limitação, não instalação", () => {
  const evidence: VerificationEvidence = {
    riskProfile: createMockProfile("low", "high"),
    taskType: "feature",
    changedPaths: ["src/some.ts"],
    candidatePaths: [],
    nearbyTests: [],
    dependentPaths: [],
    availableChecks: mockChecks,
    environment: { dependenciesInstalled: false }
  };
  const plan = planVerification(evidence);
  assert.ok(plan.limitations.includes("Project dependencies are not installed; recommended checks may not run until the workspace dependencies are prepared."));
});
