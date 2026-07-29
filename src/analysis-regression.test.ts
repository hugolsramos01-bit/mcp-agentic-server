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
