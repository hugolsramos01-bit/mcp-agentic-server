import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskContext } from "./task-context.js";
import { join } from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("task-context", () => {
  it("discovers files and test proximity deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-tc-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "payment.ts"), "export const a = 1;");
    await writeFile(join(root, "src", "payment.test.ts"), "import {a} from './payment';");
    await mkdir(join(root, ".git")); // mock git root
    
    // We cannot easily test git ls-files without a real repo or mocking execFile
    // Since we fallback to empty if no git, we'll test the extraction and fallback
    const res = await buildTaskContext({
      cwd: root,
      allowedRoots: [root],
      goal: "fix payment logic in src/payment.ts",
      maxTokens: 15000
    });
    
    assert.equal(res.taskType, "bug_fix");
    assert.equal(res.taskTypeSource, "inferred");
    
    // extractedPath should be present
    const primary = res.primaryFiles.find(p => p.path === "src/payment.ts");
    assert.ok(primary, "src/payment.ts should be a primary candidate");
    assert.ok(primary.evidence.some(e => e.type === "extracted_path"), "should have extracted_path evidence");
    
    // Test proximity should link them
    assert.ok(primary.evidence.some(e => e.type === "test_proximity"), "payment.ts should have test_proximity evidence");
    assert.ok(res.nearbyTestCandidates.some(t => t.sourcePath === "src/payment.ts" && t.testPaths.includes("src/payment.test.ts")), "nearbyTestCandidates should link them");
  });

  it("truncates candidates when over budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-tc-2-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    // Create multiple files to exceed budget
    for (let i = 0; i < 20; i++) {
      await writeFile(join(root, "src", `page${i}.tsx`), "foo");
    }
    
    const res = await buildTaskContext({
      cwd: root,
      allowedRoots: [root],
      goal: "adicionar rota de pagamento em src/page0.tsx src/page1.tsx", // force candidates
      maxTokens: 600 // Base is 500, +150 per candidate = 650 > 600
    });
    
    // base tokens is 500, so 100 will definitely truncate
    assert.equal(res.budget.truncated, true);
    assert.ok(res.budget.omittedCandidates > 0);
  });
});
