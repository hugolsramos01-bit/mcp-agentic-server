import { test, describe, afterEach } from "node:test";
import * as assert from "node:assert";
import { resolveWorkspacePath } from "../security/path-resolution.js";
import { loadAndExtractCodeRegions, clearCodeRegionCache, CodeRegionSkippedError } from "./code-region-cache.js";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock para workspaceRoot usando o temp dir
const workspaceRoot = tmpdir();

test("loadAndExtractCodeRegions cache and limits", async (t) => {
  afterEach(() => {
    clearCodeRegionCache();
  });

  await t.test("throws file_too_large if over 512KB", async () => {
    const dummyPath = "test-too-large.ts";
    const absolutePath = join(workspaceRoot, dummyPath);
    // criar arquivo muito grande
    const buffer = Buffer.alloc(512 * 1024 + 1, "a");
    await writeFile(absolutePath, buffer);

    try {
      await loadAndExtractCodeRegions({
        workspaceRoot,
        path: dummyPath
      });
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.strictEqual(e instanceof CodeRegionSkippedError, true);
      assert.strictEqual(e.reason, "file_too_large");
    } finally {
      await rm(absolutePath).catch(() => {});
    }
  });

  await t.test("caches AST extraction on subsequent calls", async () => {
    const dummyPath = "test-cache.ts";
    const absolutePath = join(workspaceRoot, dummyPath);
    await writeFile(absolutePath, "export function abc() {}");

    try {
      const res1 = await loadAndExtractCodeRegions({
        workspaceRoot,
        path: dummyPath
      });
      assert.strictEqual(res1.codeRegions.length, 1);

      // rewrite file should invalidate cache if size or mtime differs
      // but if we call immediately it will hit the cache. We can't mock stat easily without mocking node:fs, 
      // but we can just test if calling it twice works.
      const res2 = await loadAndExtractCodeRegions({
        workspaceRoot,
        path: dummyPath
      });
      
      // Should return exact same array reference if from cache
      assert.strictEqual(res1.codeRegions, res2.codeRegions);
      
      // se re-escrever com mtime diferente, deve re-extrair
      // Espera um tico para o mtime mudar
      await new Promise(r => setTimeout(r, 100));
      await writeFile(absolutePath, "export function abc() {} export function def() {}");
      
      const res3 = await loadAndExtractCodeRegions({
        workspaceRoot,
        path: dummyPath
      });
      
      assert.strictEqual(res3.codeRegions.length, 2);
      assert.notStrictEqual(res1.codeRegions, res3.codeRegions);
      
    } finally {
      await rm(absolutePath).catch(() => {});
    }
  });
});
