import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizePaths, scoreCheckRules, determineConfidence, selectTargetedChecks } from "./check-selector.js";
import type { ClassifiedCheck } from "./check-classifier.js";

describe("check-selector", () => {
  describe("normalizePaths", () => {
    it("deduplicates and normalizes paths", () => {
      const paths = [
        "src\\file.ts",
        "./src/file.ts",
        "src/file.ts",
        "/absolute/path.ts",
        "../outside.ts",
        "C:\\Windows\\System32\\file.dll"
      ];
      const result = normalizePaths(paths);
      assert.deepStrictEqual(result, ["src/file.ts"]);
    });
  });

  describe("scoreCheckRules", () => {
    const fakeCheck = (tier: string): ClassifiedCheck => ({
      script: "test",
      command: "test",
      tier: tier as any,
      reason: "",
      confidence: "medium",
      mutatesWorkspace: false,
      estimatedCost: "medium"
    });

    it("handles docs only changes", () => {
      const { score, evidence } = scoreCheckRules(fakeCheck("static_analysis"), ["README.md", "docs/API.md"]);
      assert.strictEqual(score, -100);
      assert.strictEqual(evidence[0].rule, "documentation_only");
    });

    it("scores typescript files for static analysis", () => {
      const { score, evidence } = scoreCheckRules(fakeCheck("static_analysis"), ["src/file.ts"]);
      assert.strictEqual(score, 30);
      assert.strictEqual(evidence[0].rule, "typescript_extension");
    });

    it("scores test files for unit tests", () => {
      const { score, evidence } = scoreCheckRules(fakeCheck("unit_tests"), ["src/file.test.ts"]);
      // +30 for .ts, +50 for test
      assert.strictEqual(score, 80); 
    });

    it("scores http paths for e2e tests", () => {
      const { score, evidence } = scoreCheckRules(fakeCheck("e2e_tests"), ["src/http/server.ts"]);
      // +40 for http
      assert.strictEqual(score, 40); 
      assert.strictEqual(evidence[0].rule, "http_transport_path");
    });
  });

  describe("selectTargetedChecks", () => {
    const checks: ClassifiedCheck[] = [
      { script: "typecheck", command: "npm run typecheck", tier: "static_analysis", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "low" },
      { script: "test", command: "npm run test", tier: "general_tests", reason: "", confidence: "medium", mutatesWorkspace: false, estimatedCost: "medium" },
      { script: "build", command: "npm run build", tier: "build", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
      { script: "test:http", command: "npm run test:http", tier: "e2e_tests", reason: "", confidence: "high", mutatesWorkspace: false, estimatedCost: "high" },
      { script: "format", command: "npm run format", tier: "other", reason: "", confidence: "low", mutatesWorkspace: true, estimatedCost: "low" }
    ];

    it("returns deferred for everything if no paths changed", () => {
      const result = selectTargetedChecks(checks, {}, "provided_paths", []);
      assert.strictEqual(result.recommended.length, 0);
      assert.strictEqual(result.deferred.length, 4); // mutatesWorkspace is filtered out completely
    });

    it("recommends typecheck for minimal TS changes", () => {
      const result = selectTargetedChecks(checks, { level: "minimal" }, "provided_paths", ["src/index.ts"]);
      assert.strictEqual(result.recommended.length, 1);
      assert.strictEqual(result.recommended[0].script, "typecheck");
      // build and e2e are deferred
      assert.strictEqual(result.deferred.some(d => d.script === "build"), true);
      assert.strictEqual(result.deferred.some(d => d.script === "test:http"), true);
      // mutatesWorkspace format is ignored
      assert.strictEqual(result.deferred.some(d => d.script === "format"), false);
    });

    it("recommends typecheck and test for recommended TS test changes", () => {
      const result = selectTargetedChecks(checks, { level: "recommended" }, "provided_paths", ["src/index.test.ts"]);
      assert.strictEqual(result.recommended.length, 2);
      assert.strictEqual(result.recommended.some(r => r.script === "typecheck"), true);
      assert.strictEqual(result.recommended.some(r => r.script === "test"), true);
    });

    it("recommends everything safe in full mode", () => {
      const result = selectTargetedChecks(checks, { level: "full" }, "provided_paths", ["src/index.ts"]);
      assert.strictEqual(result.recommended.length, 4);
      assert.strictEqual(result.deferred.length, 0);
    });
  });
});
