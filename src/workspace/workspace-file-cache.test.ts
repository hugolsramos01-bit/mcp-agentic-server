import test from "node:test";
import assert from "node:assert";
import { getWorkspaceFileCacheKey, getWorkspaceFileSnapshot, setWorkspaceFileSnapshot, invalidateWorkspaceFileSnapshot, clearWorkspaceFileCache } from "./workspace-file-cache.js";

test("Workspace File Cache", async (t) => {
  t.beforeEach(() => {
    clearWorkspaceFileCache();
  });

  await t.test("cache hit and expiration", async () => {
    const cacheKey = getWorkspaceFileCacheKey("w1", "/root");
    
    assert.strictEqual(getWorkspaceFileSnapshot(cacheKey), null);
    
    const snapshot = setWorkspaceFileSnapshot(cacheKey, ["a.ts", "b.ts"]);
    assert.strictEqual(snapshot.files.length, 2);
    assert.strictEqual(snapshot.fileSet.has("a.ts"), true);
    assert.strictEqual(snapshot.indexedPaths.length, 2);
    
    const cached = getWorkspaceFileSnapshot(cacheKey);
    assert.strictEqual(cached, snapshot);
    
    // Invalidate
    invalidateWorkspaceFileSnapshot("w1", "/root");
    assert.strictEqual(getWorkspaceFileSnapshot(cacheKey), null);
  });
});
