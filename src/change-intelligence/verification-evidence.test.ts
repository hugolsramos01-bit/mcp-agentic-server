import { test } from "node:test";
import * as assert from "node:assert";
import { buildVerificationEvidence } from "./verification-evidence.js";

test("buildVerificationEvidence is deterministic regardless of changedPaths order", async () => {
  const options1 = {
    cwd: process.cwd(),
    packageManager: "npm" as const,
    changedPaths: ["src/a.ts", "src/b.ts", "src/core.ts", "src/d.ts"],
    goal: "Test",
    taskType: "feature" as const,
    availableChecks: []
  };

  const options2 = {
    ...options1,
    changedPaths: ["src/core.ts", "src/d.ts", "src/b.ts", "src/a.ts"]
  };

  const evidence1 = await buildVerificationEvidence(options1);
  const evidence2 = await buildVerificationEvidence(options2);

  assert.deepStrictEqual(evidence1?.riskProfile, evidence2?.riskProfile);
  assert.deepStrictEqual(evidence1?.changedPaths, evidence2?.changedPaths);
});
