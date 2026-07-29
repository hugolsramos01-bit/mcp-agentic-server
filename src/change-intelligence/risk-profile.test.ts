import { test, describe } from "node:test";
import * as assert from "node:assert";
import { calculateRiskProfile } from "./risk-profile.js";
import { CandidateAssessment, RiskProfileInput, DirectDependentEntry, NearbyTestCandidate, TaskFocusScope } from "./types.js";

const mockFocus: TaskFocusScope = { active: false, exactFiles: [], directories: [], matchedFileCount: 0, unresolved: [] };

function mockAssessment(path: string, confidence: "low"|"medium"|"high" = "high", primaryEligible: boolean = true): CandidateAssessment {
  return {
    path,
    kind: path.endsWith(".json") || path.endsWith(".lock") || path.endsWith(".js") ? "configuration" : "source",
    evidence: [],
    score: 10,
    confidence,
    primaryEligible,
    autoReadEligible: true,
    eligibilityReasons: [],
    rejectionReasons: [],
  };
}

describe("calculateRiskProfile", () => {
  test("1 source, sem dependentes -> low", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("src/app.ts")],
      directDependents: [],
      nearbyTestCandidates: [ { sourcePath: "src/app.ts", testPaths: ["src/app.test.ts"] } ],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "low");
  });

  test("package.json -> high", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("package.json")],
      directDependents: [],
      nearbyTestCandidates: [],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some(f => f.code === "configuration_scope" && f.weight === 40));
  });

  test("eslint.config.js isolado -> medium, não high automático", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("eslint.config.js")],
      directDependents: [],
      nearbyTestCandidates: [],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "low");
    assert.ok(risk.factors.some(f => f.code === "configuration_scope" && f.weight === 15));
  });

  test("11 dependentes únicos -> high", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("src/app.ts")],
      directDependents: [
        { source: "src/app.ts", dependents: Array.from({ length: 11 }, (_, i) => `dep${i}.ts`), confidence: "high", limitations: [] }
      ],
      nearbyTestCandidates: [ { sourcePath: "src/app.ts", testPaths: ["src/app.test.ts"] } ],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some(f => f.code === "fan_out" && f.weight === 45));
  });

  test("dependentes duplicados contados uma vez", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("src/app.ts"), mockAssessment("src/utils.ts")],
      directDependents: [
        { source: "src/app.ts", dependents: ["a.ts", "b.ts"], confidence: "high", limitations: [] },
        { source: "src/utils.ts", dependents: ["b.ts", "c.ts"], confidence: "high", limitations: [] },
      ],
      nearbyTestCandidates: [ 
        { sourcePath: "src/app.ts", testPaths: ["src/app.test.ts"] },
        { sourcePath: "src/utils.ts", testPaths: ["src/utils.test.ts"] },
      ],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.blastRadius.uniqueDirectDependents, 3);
  });

  test("config sensível + 11 dependentes -> critical", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("package.json"), mockAssessment("src/app.ts")],
      directDependents: [
        { source: "src/app.ts", dependents: Array.from({ length: 11 }, (_, i) => `dep${i}.ts`), confidence: "high", limitations: [] }
      ],
      nearbyTestCandidates: [ { sourcePath: "src/app.ts", testPaths: ["src/app.test.ts"] } ],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "critical");
    assert.equal(risk.score, 85); // 40 (config) + 45 (fan_out)
  });

  test("root focus com 100 arquivos -> high ou combinação crítica", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: { ...mockFocus, matchedFileCount: 105 },
      assessments: [mockAssessment("src/app.ts")],
      directDependents: [],
      nearbyTestCandidates: [],
    };
    const risk = calculateRiskProfile(input);
    assert.ok(["high", "critical"].includes(risk.level));
    assert.ok(risk.factors.some(f => f.code === "broad_focus" && f.weight === 30));
  });

  test("depth fast sem dependentes -> level calculado, confidence low, dependencyAnalysis not_run", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "fast",
      focusScope: mockFocus,
      assessments: [mockAssessment("src/app.ts")],
      directDependents: [],
      nearbyTestCandidates: [ { sourcePath: "src/app.ts", testPaths: ["src/app.test.ts"] } ],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.level, "low");
    assert.equal(risk.confidence, "low");
    assert.equal(risk.coverage.dependencyAnalysis, "not_run");
  });

  test("balanced com mais de 3 primários -> dependencyAnalysis partial", () => {
    const input: RiskProfileInput = {
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [
        mockAssessment("src/1.ts"), mockAssessment("src/2.ts"), mockAssessment("src/3.ts"), mockAssessment("src/4.ts")
      ],
      directDependents: [],
      nearbyTestCandidates: [],
    };
    const risk = calculateRiskProfile(input);
    assert.equal(risk.coverage.dependencyAnalysis, "partial");
    assert.equal(risk.confidence, "medium");
  });

  test("mesmo input em ordens diferentes -> resultado idêntico", () => {
    const factors1 = calculateRiskProfile({
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("package.json"), mockAssessment("src/app.ts")],
      directDependents: [ { source: "src/app.ts", dependents: ["a.ts"], confidence: "high", limitations: [] } ],
      nearbyTestCandidates: [],
    }).factors;

    const factors2 = calculateRiskProfile({
      taskType: "feature",
      goalIntent: "implementation",
      effectiveDepth: "balanced",
      focusScope: mockFocus,
      assessments: [mockAssessment("src/app.ts"), mockAssessment("package.json")], // reordered
      directDependents: [ { source: "src/app.ts", dependents: ["a.ts"], confidence: "high", limitations: [] } ],
      nearbyTestCandidates: [],
    }).factors;

    assert.deepEqual(factors1, factors2);
    // configuration_scope should be before test_proximity_gap
    assert.equal(factors1[0].code, "configuration_scope");
    assert.equal(factors1[1].code, "test_proximity_gap");
  });
});
