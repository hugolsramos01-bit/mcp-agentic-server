import { test } from "node:test";
import * as assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestChecksTool } from "../bootstrap-tools.js";
import { buildVerificationEvidence } from "./verification-evidence.js";

test("buildVerificationEvidence is deterministic regardless of changedPaths order", async () => {
  const options1 = {
    cwd: process.cwd(),
    packageManager: "npm" as const,
    changedPaths: ["src/a.ts", "src/b.ts", "src/core.ts", "src/d.ts"],
    goal: "Test",
    taskType: "feature" as const,
    availableChecks: [],
  };

  const options2 = {
    ...options1,
    changedPaths: ["src/core.ts", "src/d.ts", "src/b.ts", "src/a.ts"],
  };

  const evidence1 = await buildVerificationEvidence(options1);
  const evidence2 = await buildVerificationEvidence(options2);

  assert.deepStrictEqual(evidence1?.riskProfile, evidence2?.riskProfile);
  assert.deepStrictEqual(evidence1?.changedPaths, evidence2?.changedPaths);
});

test("suggest_checks uses goal_discovery without Git metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-no-git-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "src", "lease"), { recursive: true });
  await mkdir(join(root, "tests", "integration"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        "test:integration": "node tests/integration/run.mjs",
        "ci:verify": "node scripts/verify-ci.mjs",
      },
    }),
  );
  await writeFile(
    join(root, "src", "lease", "lease-manager.ts"),
    "export const acquireLease = () => 'fencing lock';\n",
  );
  await writeFile(
    join(root, "tests", "integration", "lease-fencing.test.ts"),
    "import '../../../src/lease/lease-manager.js';\n",
  );

  const response = await suggestChecksTool(root, {
    goal: "Corrigir concorrência no lease distribuído e fencing",
    focusPaths: [
      "src/lease/lease-manager.ts",
      "tests/integration/lease-fencing.test.ts",
    ],
  });
  const payload = JSON.parse((response.content[0] as { text: string }).text);
  const plan = payload.plan;

  assert.strictEqual(plan.basis, "goal_discovery");
  assert.ok(
    plan.limitations.includes(
      "Git metadata unavailable; plan derived from goal and focused paths.",
    ),
  );
  assert.deepStrictEqual(
    plan.recommendations.map((item: { script: string }) => item.script),
    ["typecheck", "lint", "test:integration", "ci:verify"],
  );
  assert.strictEqual(
    plan.recommendations.find(
      (item: { script: string }) => item.script === "test:integration",
    )?.stage,
    "after_initial_success",
  );
  assert.strictEqual(
    plan.recommendations.find(
      (item: { script: string }) => item.script === "ci:verify",
    )?.stage,
    "before_release",
  );
});
