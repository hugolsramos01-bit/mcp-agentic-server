import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compressAST } from "./context-engine/compressors.js";
import { discoverFastApi } from "./fastapi-tools.js";
import { buildTaskContext } from "./change-intelligence/task-context.js";

const execFileAsync = promisify(execFile);

async function initGit(root: string) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
}

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
    await initGit(root);
    const result = await discoverFastApi(root);
    assert.equal(result.detected, true);
    assert.equal(result.entrypoints.includes("main.py"), true);
    assert.equal(result.routers.includes("users.py"), true);
    assert.equal(result.routes.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 1: Artifacts vs Domain (eslint_out.json loses to source files and gets autoReadEligible: false)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-1-"));
  try {
    await writeFile(join(root, "auth.ts"), "export const auth = () => true;");
    await writeFile(join(root, "eslint_out.json"), "{}");
    await initGit(root);
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

test("Case 2: Ranking sem foco (app/admin/page vs admin-tenant-context)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-2-"));
  try {
    await mkdir(join(root, "app/admin/users"), { recursive: true });
    await mkdir(join(root, "payload/lib"), { recursive: true });
    await writeFile(join(root, "app/admin/page.tsx"), "export default function Admin() {}");
    await writeFile(join(root, "app/admin/users/page.tsx"), "export default function Users() {}");
    await writeFile(join(root, "payload/lib/admin-tenant-context.ts"), "export const tenant = 1;");
    await initGit(root);
    
    const result = await buildTaskContext({
      goal: "corrigir parsing do cookie de contexto tenant",
      type: "auto",
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace"
    });
    
    const allCands = [...result.primaryFiles, ...result.supportingFiles];
    const tenantCtx = allCands.find(c => c.path.endsWith("admin-tenant-context.ts"));
    const pages = allCands.filter(c => c.path.endsWith("page.tsx"));
    
    assert.ok(tenantCtx, "admin-tenant-context.ts should be found");
    assert.equal(tenantCtx.role, "primary", "admin-tenant-context.ts deve ser primary");
    assert.equal(result.primaryFiles[0].path, tenantCtx.path, "admin-tenant-context.ts deve ser o primeiro colocado");
    
    for (const page of pages) {
      assert.notEqual(page.role, "primary", "pages não podem ser primary");
      assert.ok(page.confidence === "medium" || page.confidence === "low", "pages no maximo medium");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Case 3: Artifact isolation (grep fallback quando apenas gerados/bloqueados)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-3-"));
  try {
    await writeFile(join(root, "package-lock.json"), "{}");
    await initGit(root);
    
    const result = await buildTaskContext({
      goal: "verificar dependencias",
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
    await initGit(root);
    
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

test("Case 5: Determinismo real", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-test-5-"));
  try {
    await writeFile(join(root, "auth.ts"), "export const auth = () => true;");
    await writeFile(join(root, "other.ts"), "export const other = () => true;");
    await initGit(root);
    
    const input = {
      goal: "fix auth",
      type: "auto" as const,
      cwd: root,
      allowedRoots: [root],
      workspaceId: "test-workspace"
    };

    const baseline = await buildTaskContext(input);

    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await buildTaskContext(input);
      assert.deepEqual(current.primaryFiles, baseline.primaryFiles);
      assert.deepEqual(current.supportingFiles, baseline.supportingFiles);
      assert.deepEqual(current.suggestedNextSteps, baseline.suggestedNextSteps);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
