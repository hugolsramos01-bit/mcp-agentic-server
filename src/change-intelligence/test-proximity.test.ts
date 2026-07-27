import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findNearbyTests } from "./test-proximity.js";
import { join } from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("test-proximity", () => {
  it("detects sibling test files and __tests__ folder tests", () => {
    const filePath = "src/foo.ts";
    const allFiles = [
      "src/foo.ts",
      "src/foo.test.ts",
      "src/__tests__/foo.spec.ts",
      "src/other.ts"
    ];
    
    const tests = findNearbyTests(filePath, allFiles);
    assert.equal(tests.length, 2);
    assert.ok(tests.includes("src/foo.test.ts"));
    assert.ok(tests.includes("src/__tests__/foo.spec.ts"));
  });

  it("returns empty array for file without nearby test", () => {
    const filePath = "bar.ts";
    const allFiles = ["bar.ts", "other.test.ts"];
    
    const tests = findNearbyTests(filePath, allFiles);
    assert.equal(tests.length, 0);
  });
});
