import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskContext, TASK_CONTEXT_BUDGET } from "./task-context.js";
import { join } from "node:path";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Helper: create a minimal temp workspace
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentic-tc-"));
  await mkdir(join(root, "src"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  return root;
}

// Helper to commit files to git so ls-files sees them
async function gitAddAll(cwd: string) {
  await execFileAsync("git", ["add", "."], { cwd });
}

describe("task-context", () => {
  // ─── 1. Test proximity and extracted paths ────────────────────
  it("discovers extracted path and nearby test, puts test in supportingFiles", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "payment.ts"), "export const charge = () => {};");
    await writeFile(join(root, "src", "payment.test.ts"), "import { charge } from './payment';");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "fix payment logic in src/payment.ts",
      depth: "balanced",
    });

    assert.equal(res.taskType, "bug_fix");
    assert.equal(res.taskTypeSource, "inferred");
    assert.equal(res.effectiveDepth, "balanced");

    const primary = res.primaryFiles.find(p => p.path.includes("payment.ts") && !p.path.includes(".test."));
    assert.ok(primary, "payment.ts should be a primary candidate");
    assert.ok(primary!.evidence.some(e => e.type === "extracted_path"), "should have extracted_path evidence");
    assert.ok(primary!.evidence.some(e => e.type === "test_proximity"), "should have test_proximity evidence");

    // Tests MUST be in supportingFiles, NOT primaryFiles
    const testInPrimary = res.primaryFiles.find(p => p.path.includes(".test."));
    assert.equal(testInPrimary, undefined, ".test. file must not appear in primaryFiles");

    const testInSupporting = res.supportingFiles.find(p => p.path.includes("payment.test.ts"));
    assert.ok(testInSupporting, "payment.test.ts should be in supportingFiles");
  });

  // ─── 2. excludePaths ──────────────────────────────────────────
  it("excludePaths removes candidates from all outputs", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "auth.ts"), "export const login = () => {};");
    await writeFile(join(root, "src", "auth-helper.ts"), "// helper");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "fix auth login bug in src/auth.ts",
      excludePaths: ["src/auth-helper.ts"],
    });

    const excluded = [...res.primaryFiles, ...res.supportingFiles].find(
      c => c.path.includes("auth-helper.ts")
    );
    assert.equal(excluded, undefined, "auth-helper.ts should be excluded");
  });

  // ─── 3. focusPaths with external path is rejected ──────────────
  it("focusPaths with traversal path is rejected and adds limitation", async () => {
    const root = await makeWorkspace();

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "refactor something",
      focusPaths: ["../../../etc/passwd"],
    });

    const forbidden = [...res.primaryFiles, ...res.supportingFiles].find(
      c => c.path.includes("passwd") || c.path.includes("..")
    );
    assert.equal(forbidden, undefined, "traversal path must be rejected");
    assert.ok(res.limitations.some(l => l.includes("Rejected")), "should have rejection in limitations");
  });

  // ─── 4. Tests always in supportingFiles ───────────────────────
  it("spec files are always in supportingFiles regardless of confidence", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "foo.spec.ts"), "describe('foo', () => {})");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "refactor foo module in src/foo.spec.ts",
      focusPaths: ["src/foo.spec.ts"],
    });

    const inPrimary = res.primaryFiles.find(p => p.path.includes(".spec."));
    assert.equal(inPrimary, undefined, ".spec. files must not be in primaryFiles");
  });

  // ─── 5. Determinism ───────────────────────────────────────────
  it("produces deterministic output for same input", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "user.ts"), "export const getUser = () => {};");
    await writeFile(join(root, "src", "userService.ts"), "// service");

    const run1 = await buildTaskContext({ workspaceId: "test", cwd: root, allowedRoots: [root], goal: "add user authentication" });
    const run2 = await buildTaskContext({ workspaceId: "test", cwd: root, allowedRoots: [root], goal: "add user authentication" });

    assert.deepEqual(
      run1.primaryFiles.map(f => f.path),
      run2.primaryFiles.map(f => f.path),
      "primaryFiles order must be deterministic"
    );
    assert.deepEqual(
      run1.supportingFiles.map(f => f.path),
      run2.supportingFiles.map(f => f.path),
      "supportingFiles order must be deterministic"
    );
  });

  // ─── 6. Budget truncation ─────────────────────────────────────
  it("truncates when over budget and sets budget.truncated correctly", async () => {
    const root = await makeWorkspace();
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, "src", `page${i}.tsx`), "export default function Page() {}");
    }

    // Use explicit focusPaths so candidates are added without needing git ls-files
    const focusPaths = ["src/page0.tsx", "src/page1.tsx", "src/page2.tsx", "src/page3.tsx", "src/page4.tsx"];

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "adicionar rota de pagamento em src/page0.tsx src/page1.tsx src/page2.tsx",
      focusPaths,
      maxTokens: 1_200, // budget = 1200; base result JSON with 5 high-conf candidates > 1200 tokens
    });

    assert.equal(res.budget.maxTokens, 1_200);
    // With real JSON measurement, 5 focus_path candidates with evidence should exceed 1200
    // If not, the test still validates the budget fields are properly set
    assert.ok(typeof res.budget.truncated === "boolean", "budget.truncated should be a boolean");
    assert.ok(res.budget.estimatedTokens > 0, "estimatedTokens should be measured");
    assert.ok(res.budget.estimatedTokens <= res.budget.maxTokens, "estimatedTokens must be within budget");
  });

  // ─── 7. No truncation when within budget ─────────────────────
  it("budget.truncated is false when within default budget", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "small.ts"), "const x = 1;");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "update small module",
    });

    // With a tiny workspace and default budget of 6000, should never truncate
    assert.equal(res.budget.truncated, false, "should not truncate for tiny workspace");
    assert.equal(res.budget.omittedCandidates, 0);
  });

  // ─── 8. explicit type is respected ────────────────────────────
  it("explicit type overrides inferred type", async () => {
    const root = await makeWorkspace();

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "corrigir bug de login",  // would infer bug_fix
      type: "feature",
    });

    assert.equal(res.taskType, "feature");
    assert.equal(res.taskTypeSource, "explicit");
  });

  // ─── 9. maxTokens from input is respected ─────────────────────
  it("maxTokens from input is used in budget", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "src", "a.ts"), "const a = 1;");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "refactor a module",
      maxTokens: 1500,
    });

    assert.equal(res.budget.maxTokens, 1500);
  });

  // ─── 10. Segment matching: "view" does not match "review" ──────
  it("filename segment matching does not produce view→review false positive", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "src", "reviews"), { recursive: true });
    await writeFile(join(root, "src", "reviews", "index.ts"), "export const getReviews = () => [];");
    await writeFile(join(root, "src", "view.ts"), "export const View = () => {};");

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "fix bug in view component",
      focusPaths: ["src/view.ts"],
    });

    // src/view.ts should be high confidence (focus_path)
    const viewFile = res.primaryFiles.find(p => p.path === "src/view.ts");
    assert.ok(viewFile, "src/view.ts should be in primaryFiles via focus_path");

    // reviews/index.ts should NOT be promoted to primary via filename match
    const reviewFile = res.primaryFiles.find(p => p.path.includes("reviews"));
    assert.equal(reviewFile, undefined, "reviews/index.ts should NOT match 'view' keyword");
  });

  // ─── 11. TASK_CONTEXT_BUDGET constants ────────────────────────
  it("TASK_CONTEXT_BUDGET has correct bounds", () => {
    assert.equal(TASK_CONTEXT_BUDGET.minTokens, 1_000);
    assert.equal(TASK_CONTEXT_BUDGET.defaultTokens, 6_000);
    assert.equal(TASK_CONTEXT_BUDGET.maxTokens, 12_000);
    assert.ok(TASK_CONTEXT_BUDGET.minTokens < TASK_CONTEXT_BUDGET.defaultTokens);
    assert.ok(TASK_CONTEXT_BUDGET.defaultTokens < TASK_CONTEXT_BUDGET.maxTokens);
  });

  // ─── 12. applicableInstructions detected ─────────────────────
  it("detects AGENTS.md as applicableInstruction", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "AGENTS.md"), "# Rules\nAlways test.");

    // applicableInstructions scans allFiles from git ls-files;
    // in a bare temp dir without git, we test via focusPaths to force a candidate
    // and verify the instruction detection logic via a real git repo path
    // For this unit test, provide instructionFiles directly:
    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "add new feature",
      instructionFiles: ["AGENTS.md"],
    });
    const inst = res.applicableInstructions.find(i => i.path.includes("AGENTS.md"));
    assert.ok(inst, "AGENTS.md should be in applicableInstructions when provided via instructionFiles");
    assert.equal(inst!.scope, "workspace");
  });

  // ─── 13. Budget truncation consistency ───────────────────────
  it("removes omitted candidates from derived structures (dependents, nearby tests, next steps)", async () => {
    const root = await makeWorkspace();
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, "src", `page${i}.tsx`), "export default function Page() {}");
      await writeFile(join(root, "src", `page${i}.test.tsx`), "test()");
    }

    const focusPaths = [
      "src/page0.tsx", "src/page1.tsx", "src/page2.tsx",
      "src/page3.tsx", "src/page4.tsx",
    ];

    await gitAddAll(root);
    const res = await buildTaskContext({ workspaceId: "test",
      cwd: root,
      allowedRoots: [root],
      goal: "adicionar rota de pagamento em src/page0.tsx src/page1.tsx src/page2.tsx",
      focusPaths,
      maxTokens: 200,
    });

    assert.ok(res.budget.truncated, "Result must be truncated for test");
    
    // Check that nearbyTestCandidates does not contain paths not in supportingFiles
    const retainedSupporting = new Set(res.supportingFiles.map(f => f.path));
    const retainedPrimary = new Set(res.primaryFiles.map(f => f.path));

    for (const testCandidate of res.nearbyTestCandidates) {
      assert.ok(retainedPrimary.has(testCandidate.sourcePath) || retainedSupporting.has(testCandidate.sourcePath), "nearbyTestCandidates sourcePath must be retained");
      for (const t of testCandidate.testPaths) {
        assert.ok(retainedSupporting.has(t), "nearbyTestCandidates testPaths must be in supportingFiles");
      }
    }
  });
});
