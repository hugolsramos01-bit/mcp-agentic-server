import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressAST } from "./context-engine/compressors.js";
import { discoverFastApi } from "./fastapi-tools.js";

test("skeletal compression emits an actual declaration outline", () => {
  const source = `${"export function worker() {\n  console.log('x');\n".repeat(500)}\n}`;
  const result = compressAST(source, "skeletal", undefined, { displayPath: "test.ts" });
  assert.equal(result.metadata.compressionEffective, true);
  assert.ok(result.metadata.outputTokensEstimate < result.metadata.originalTokensEstimate / 2);
  assert.match(result.output, /Skeletal outline/);
});

test("skeletal compression isolates cache by absolute identity", () => {
  const contentA = "export const A = 1;";
  const contentB = "export const B = 2;";
  const sameMtime = 1234567890;
  
  const resultA = compressAST(contentA, "skeletal", undefined, {
    cacheKey: "/workspace-a/src/index.ts",
    displayPath: "src/index.ts",
    mtime: sameMtime,
  });

  const resultB = compressAST(contentB, "skeletal", undefined, {
    cacheKey: "/workspace-b/src/index.ts",
    displayPath: "src/index.ts",
    mtime: sameMtime,
  });

  assert.match(resultA.output, /const A = \/\* initializer omitted \*\//);
  assert.match(resultB.output, /const B = \/\* initializer omitted \*\//);
});

test("FastAPI discovery returns entrypoints, routers, and routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-fastapi-"));
  try {
    await writeFile(join(root, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\nasync def health(): return {}\n");
    await writeFile(join(root, "users.py"), "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/users')\ndef create_user(): return {}\n");
    const result = await discoverFastApi(root);
    assert.equal(result.detected, true);
    assert.equal(result.entrypoints.includes("main.py"), true);
    assert.equal(result.routers.includes("users.py"), true);
    assert.equal(result.routes.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { buildTaskContext } from "./change-intelligence/task-context.js";

test("Case 1: Artifacts vs Domain (eslint_out.json loses to source files and gets autoReadEligible: false)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-1-"));
  try {
    await writeFile(join(root, "auth.ts"), "export const auth = () => true;");
    await writeFile(join(root, "eslint_out.json"), "{}");
    const result = await buildTaskContext({
      goal: "fix authentication bug",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace"
    });
    
    const allCands = [...result.primaryFiles, ...result.supportingFiles];
    const authCandidate = allCands.find(c => c.path.endsWith("auth.ts"));
    const eslintCandidate = allCands.find(c => c.path.endsWith("eslint_out.json"));
    
    assert.ok(authCandidate, "auth.ts should be found");
    assert.equal(authCandidate.role === "primary" || authCandidate.role === "supporting", true);
    if (eslintCandidate) {
      assert.equal(eslintCandidate.autoReadEligible, false, "eslint_out.json should not be autoReadEligible");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 2: Generic routes vs exact match (focus_path/filename beats weak keyword)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-2-"));
  try {
    await writeFile(join(root, "app.ts"), "const app = true;");
    await writeFile(join(root, "specific_logic.ts"), "const specific = true;");
    
    const result = await buildTaskContext({
      goal: "update specific_logic route",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace",
      focusPaths: ["specific_logic.ts"]
    });
    
    const allCands = [...result.primaryFiles, ...result.supportingFiles];
    const specificCandidate = allCands.find(c => c.path.endsWith("specific_logic.ts"));
    assert.ok(specificCandidate, "specific_logic.ts should be found");
    assert.equal(specificCandidate.role, "primary", "specific_logic.ts should be primary due to focus_path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 3: Artifact isolation (grep fallback when only config/generated exists)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-3-"));
  try {
    await writeFile(join(root, "eslint_out.json"), "{}");
    
    const result = await buildTaskContext({
      goal: "check eslint output",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace"
    });
    
    assert.equal(result.primaryFiles.length, 0);
    const nextStep = result.suggestedNextSteps[0];
    assert.equal(nextStep.tool, "grep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 4: Explicit exception (package-lock.json is read if explicitly focused)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-4-"));
  try {
    await writeFile(join(root, "package-lock.json"), "{}");
    
    const result = await buildTaskContext({
      goal: "update dependencies",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace",
      focusPaths: ["package-lock.json"]
    });
    
    const allCands = [...result.primaryFiles, ...result.supportingFiles];
    const lockCandidate = allCands.find(c => c.path.endsWith("package-lock.json"));
    assert.ok(lockCandidate, "package-lock.json should be found");
    assert.equal(lockCandidate.role, "primary", "package-lock.json should be primary when explicitly focused");
    assert.equal(lockCandidate.autoReadEligible, true, "package-lock.json should be autoReadEligible when focused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 5: Determinism regression (focus on src/auth.ts isolates it)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-5-"));
  try {
    await writeFile(join(root, "auth.ts"), "export const auth = () => true;");
    await writeFile(join(root, "other.ts"), "export const other = () => true;");
    
    const result = await buildTaskContext({
      goal: "fix auth",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace",
      focusPaths: ["auth.ts"]
    });
    
    const allCands = [...result.primaryFiles, ...result.supportingFiles];
    const authCandidate = allCands.find(c => c.path.endsWith("auth.ts"));
    assert.ok(authCandidate, "auth.ts should be found");
    assert.equal(authCandidate.role, "primary", "auth.ts should be primary due to focus_path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

