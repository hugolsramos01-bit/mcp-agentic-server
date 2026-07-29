import { test, describe } from "node:test";
import * as assert from "node:assert";
import { calculateRiskProfile } from "./risk-profile.js";
import { TaskFileCandidate } from "./types.js";

const makeMockFile = (path: string): TaskFileCandidate => ({
  path,
  role: "primary",
  confidence: "high",
  evidence: [],
  recommendedReadTool: "read",
  autoReadEligible: true,
});

describe("calculateRiskProfile", () => {
  test("returns low risk for isolated source change", () => {
    const risk = calculateRiskProfile({
      goal: "fix single file",
      taskType: "implementation",
      primaryFiles: [makeMockFile("src/auth.ts")],
      directDependents: [],
    });

    assert.equal(risk.level, "low");
    assert.equal(risk.factors.length, 0);
  });

  test("returns high risk for configuration change", () => {
    const risk = calculateRiskProfile({
      goal: "update config",
      taskType: "configuration",
      primaryFiles: [makeMockFile("package.json")],
      directDependents: [],
    });

    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some((f) => f.factor === "configuration_change"));
  });

  test("returns high risk for lockfile change", () => {
    const risk = calculateRiskProfile({
      goal: "update deps",
      taskType: "configuration",
      primaryFiles: [makeMockFile("yarn.lock")],
      directDependents: [],
    });

    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some((f) => f.factor === "configuration_change"));
  });

  test("returns medium risk for moderate fan-out", () => {
    const risk = calculateRiskProfile({
      goal: "update helper",
      taskType: "implementation",
      primaryFiles: [makeMockFile("src/helper.ts")],
      directDependents: [
        {
          source: "src/helper.ts",
          dependents: ["a.ts", "b.ts", "c.ts", "d.ts"],
        },
      ],
    });

    assert.equal(risk.level, "medium");
    assert.ok(
      risk.factors.some((f) => f.factor === "fan_out" && f.weight === 15)
    );
  });

  test("returns critical risk for high fan-out and multiple factors", () => {
    const risk = calculateRiskProfile({
      goal: "update core framework",
      taskType: "implementation",
      primaryFiles: [makeMockFile("src/core.ts"), makeMockFile("package.json")],
      directDependents: [
        {
          source: "src/core.ts",
          dependents: Array.from({ length: 15 }, (_, i) => `dep${i}.ts`),
        },
      ],
    });

    assert.equal(risk.level, "critical");
    assert.ok(
      risk.factors.some((f) => f.factor === "fan_out" && f.weight === 30)
    );
    assert.ok(
      risk.factors.some(
        (f) => f.factor === "configuration_change" && f.weight === 40
      )
    );
  });

  test("returns medium risk for mass refactor (> 5 primary files)", () => {
    const risk = calculateRiskProfile({
      goal: "refactor many things",
      taskType: "implementation",
      primaryFiles: Array.from({ length: 7 }, (_, i) =>
        makeMockFile(`src/f${i}.ts`)
      ),
      directDependents: [],
    });

    assert.equal(risk.level, "medium");
    assert.ok(
      risk.factors.some((f) => f.factor === "mass_refactor" && f.weight === 25)
    );
  });
});
