import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findNearbyTests } from "./test-proximity.js";
import { join } from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("test-proximity", () => {
  it("detects sibling test files and __tests__ folder tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-test-prox-"));
    const filePath = join(root, "src", "foo.ts");
    
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(filePath, "");
    
    // Create a sibling test
    await writeFile(join(root, "src", "foo.test.ts"), "");
    
    // Create __tests__ test
    await mkdir(join(root, "src", "__tests__"), { recursive: true });
    await writeFile(join(root, "src", "__tests__", "foo.spec.ts"), "");
    
    const tests = await findNearbyTests(filePath, root);
    assert.equal(tests.length, 2);
    assert.ok(tests.includes("src/foo.test.ts"));
    assert.ok(tests.includes("src/__tests__/foo.spec.ts"));
  });

  it("returns empty array for file without nearby test", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-test-prox-"));
    const filePath = join(root, "bar.ts");
    await writeFile(filePath, "");
    
    const tests = await findNearbyTests(filePath, root);
    assert.equal(tests.length, 0);
  });
});
