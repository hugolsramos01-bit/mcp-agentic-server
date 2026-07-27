import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import {
  loadAndExtractCodeRegions,
  clearCodeRegionCache,
  CodeRegionSkippedError,
  getCodeRegionCacheSize,
} from "./code-region-cache.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), `code-region-cache-test-${process.pid}`);
mkdirSync(TMP_DIR, { recursive: true });

function makeTempFile(name: string, content: string): string {
  const filePath = join(TMP_DIR, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

const SAMPLE_TS = `
export function authenticateUser(token: string) {
  return token.startsWith("Bearer");
}

export function paginateResults(cursor: number, limit: number) {
  return { cursor, limit };
}

export class SessionManager {
  createSession(userId: string) { return userId; }
  destroySession(sessionId: string) { return sessionId; }
}
`.trim();

// ─── Tests ────────────────────────────────────────────────────────────

test("code-region-cache", async (t) => {

  await t.test("throws file_too_large if over 512KB", async () => {
    clearCodeRegionCache();
    const absolutePath = join(TMP_DIR, "too-large.ts");
    await writeFile(absolutePath, Buffer.alloc(512 * 1024 + 1, "a"));
    try {
      await assert.rejects(
        () => loadAndExtractCodeRegions({ workspaceRoot: TMP_DIR, path: "too-large.ts" }),
        (err: any) => {
          assert.ok(err instanceof CodeRegionSkippedError);
          assert.equal(err.reason, "file_too_large");
          return true;
        },
      );
    } finally {
      await rm(absolutePath).catch(() => {});
    }
  });

  await t.test("different goals receive independent rankings", async () => {
    clearCodeRegionCache();
    makeTempFile("auth.ts", SAMPLE_TS);

    const res1 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth.ts",
      anchorKeywords: ["authenticate", "session"],
      maxRegions: 2,
    });

    const res2 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth.ts",
      anchorKeywords: ["paginate", "cursor"],
      maxRegions: 2,
    });

    assert.ok(res1.codeRegions.length > 0, "res1 must have regions");
    assert.ok(res2.codeRegions.length > 0, "res2 must have regions");

    // The top-ranked region should differ because the goals differ
    assert.notEqual(res1.codeRegions[0].name, res2.codeRegions[0].name,
      "top-ranked region should differ per goal");

    // Raw index is cached only once
    assert.equal(getCodeRegionCacheSize(), 1, "one raw entry in cache");
  });

  await t.test("budget pop does not mutate the cache (clone invariant)", async () => {
    clearCodeRegionCache();
    makeTempFile("auth-budget.ts", SAMPLE_TS);

    const res1 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth-budget.ts",
      anchorKeywords: ["authenticate"],
      maxRegions: 5,
    });

    const originalLength = res1.codeRegions.length;

    // Simulate budget enforcement
    res1.codeRegions.pop();
    res1.codeRegions.pop();

    // Second call must return the full set again
    const res2 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth-budget.ts",
      anchorKeywords: ["authenticate"],
      maxRegions: 5,
    });

    assert.equal(res2.codeRegions.length, originalLength,
      "cache must not have been mutated by budget pop()");
  });

  await t.test("returned arrays are different references on every call", async () => {
    clearCodeRegionCache();
    makeTempFile("auth-clone.ts", SAMPLE_TS);

    const res1 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth-clone.ts",
      anchorKeywords: [],
    });

    const res2 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "auth-clone.ts",
      anchorKeywords: [],
    });

    // Same content, different references
    assert.deepEqual(res1.codeRegions, res2.codeRegions);
    assert.notStrictEqual(res1.codeRegions, res2.codeRegions,
      "each call must return a fresh array (defensive clone)");
  });

  await t.test("no regions for unsupported file extension", async () => {
    clearCodeRegionCache();
    makeTempFile("style.css", "body { color: red; }");

    const res = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "style.css",
    });

    assert.deepEqual(res.codeRegions, []);
  });

  await t.test("caches correctly — invalidates on file change", async () => {
    clearCodeRegionCache();
    const filePath = join(TMP_DIR, "changing.ts");
    await writeFile(filePath, "export function abc() {}");

    const res1 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "changing.ts",
    });
    assert.equal(res1.codeRegions.length, 1);

    // Wait a bit so mtime changes, then rewrite with extra function
    await new Promise(r => setTimeout(r, 100));
    await writeFile(filePath, "export function abc() {} export function def() {}");

    const res2 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "changing.ts",
    });
    assert.equal(res2.codeRegions.length, 2, "should re-extract after file change");
  });

  await t.test("P3: anchor keyword found in signature/body outranks other regions (cache neutrality)", async () => {
    // Create a file where the keyword is in the body/signature but not the name
    const tsCode = `
      export function genericProcess(input: string) {
        // no keyword here
        return input;
      }
      export function processRequest(input: PaginationCursor) {
        return validateExpiredCursor(input);
      }
    `;
    const testFile = join(TMP_DIR, "cursor.ts");
    await writeFile(testFile, tsCode);

    const res1 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "cursor.ts",
      anchorKeywords: ["cursor"],
      maxRegions: 1,
    });
    
    assert.equal(res1.codeRegions.length, 1);
    assert.equal(res1.codeRegions[0].name, "processRequest", "should rank processRequest highest because 'cursor' is in signature and body");

    // Clear and do it again to test that even on warm hit it re-ranks correctly? 
    // Wait, cache hits use the already parsed data! 
    const res2 = await loadAndExtractCodeRegions({
      workspaceRoot: TMP_DIR,
      path: "cursor.ts",
      anchorKeywords: ["cursor"],
      maxRegions: 1,
    });
    
    assert.equal(res2.codeRegions.length, 1);
    assert.equal(res2.codeRegions[0].name, "processRequest", "cache hit should also rank processRequest highest based on cached _signature and _body");
  });
});
