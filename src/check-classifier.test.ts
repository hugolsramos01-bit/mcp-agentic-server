import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyPackageScripts } from "./check-classifier.js";

describe("check-classifier", () => {
  it("classifies complete project deterministic order", () => {
    const scripts = {
      "typecheck": "tsc --noEmit",
      "test:http": "node scripts/test-http.mjs",
      "test": "node --test",
      "build": "vite build",
      "smoke:package": "node scripts/smoke-package.mjs",
    };

    const classified = classifyPackageScripts(scripts, "npm");

    assert.strictEqual(classified.length, 5);
    // Sort should be alphabetical by script name
    assert.deepStrictEqual(classified.map(c => c.script), [
      "build",
      "smoke:package",
      "test",
      "test:http",
      "typecheck"
    ]);

    const build = classified.find(c => c.script === "build")!;
    assert.strictEqual(build.tier, "build");
    assert.strictEqual(build.confidence, "high");
    assert.strictEqual(build.command, "npm run build");

    const smoke = classified.find(c => c.script === "smoke:package")!;
    assert.strictEqual(smoke.tier, "smoke_tests");
    assert.strictEqual(smoke.command, "npm run smoke:package");

    const typecheck = classified.find(c => c.script === "typecheck")!;
    assert.strictEqual(typecheck.tier, "static_analysis");
  });

  it("identifies mutating scripts and safe check scripts", () => {
    const scripts = {
      "format": "prettier --write .",
      "lint:fix": "eslint --fix .",
      "format:check": "prettier --check .",
      "weird:script": "some-cli --write --something"
    };

    const classified = classifyPackageScripts(scripts, "pnpm");

    const format = classified.find(c => c.script === "format")!;
    assert.strictEqual(format.mutatesWorkspace, true);

    const lintFix = classified.find(c => c.script === "lint:fix")!;
    assert.strictEqual(lintFix.mutatesWorkspace, true);

    const formatCheck = classified.find(c => c.script === "format:check")!;
    assert.strictEqual(formatCheck.mutatesWorkspace, false);
    assert.strictEqual(formatCheck.tier, "static_analysis");

    const weird = classified.find(c => c.script === "weird:script")!;
    assert.strictEqual(weird.mutatesWorkspace, true);
    assert.strictEqual(weird.tier, "other");
  });

  it("handles just test avoiding high unit test confidence", () => {
    const scripts = {
      "test": "jest",
      "test:unit": "jest test/unit"
    };

    const classified = classifyPackageScripts(scripts, "yarn");

    const genericTest = classified.find(c => c.script === "test")!;
    assert.strictEqual(genericTest.tier, "general_tests");
    assert.strictEqual(genericTest.confidence, "medium");
    assert.strictEqual(genericTest.command, "yarn test"); // For yarn, yarn test works

    const unitTest = classified.find(c => c.script === "test:unit")!;
    assert.strictEqual(unitTest.tier, "unit_tests");
    assert.strictEqual(unitTest.confidence, "high");
    assert.strictEqual(unitTest.command, "yarn test:unit");
  });

  it("classifies declared CI verification as a release check", () => {
    const classified = classifyPackageScripts(
      { "ci:verify": "node scripts/verify-ci.mjs" },
      "npm",
    );

    assert.strictEqual(classified[0].tier, "smoke_tests");
    assert.strictEqual(classified[0].confidence, "high");
    assert.strictEqual(classified[0].estimatedCost, "high");
    assert.strictEqual(classified[0].command, "npm run ci:verify");
  });

  it("does not drop unclassified scripts silently", () => {
    const scripts = {
      "verify-contracts": "node verify.js",
      "quality": "echo hmm"
    };

    const classified = classifyPackageScripts(scripts, "npm");
    
    assert.strictEqual(classified.length, 2);
    assert.strictEqual(classified.every(c => c.tier === "other"), true);
  });
});
