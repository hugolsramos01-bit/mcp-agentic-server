import test from "node:test";
import assert from "node:assert";
import { getWorkspaceFileCacheKey, getWorkspaceFileSnapshot, setWorkspaceFileSnapshot, invalidateWorkspaceFileSnapshot, clearWorkspaceFileCache } from "./workspace-file-cache.js";

test("Workspace File Cache", async (t) => {
  t.beforeEach(() => {
    clearWorkspaceFileCache();
  });

  await t.test("cache stays warm across normal agent reasoning gaps", async () => {
    const cacheKey = getWorkspaceFileCacheKey("w1", "/root");
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      assert.strictEqual(getWorkspaceFileSnapshot(cacheKey), null);

      const snapshot = setWorkspaceFileSnapshot(cacheKey, ["a.ts", "b.ts"]);
      assert.strictEqual(snapshot.files.length, 2);
      assert.strictEqual(snapshot.fileSet.has("a.ts"), true);
      assert.strictEqual(snapshot.indexedPaths.length, 2);

      now += 10_000;
      assert.strictEqual(
        getWorkspaceFileSnapshot(cacheKey),
        snapshot,
        "a 10-second reasoning gap must not evict the workspace index",
      );

      now += 51_000;
      assert.strictEqual(
        getWorkspaceFileSnapshot(cacheKey),
        null,
        "external changes still receive an eventual refresh window",
      );
    } finally {
      Date.now = originalNow;
    }
  });

  await t.test("explicit invalidation clears the snapshot immediately", () => {
    const cacheKey = getWorkspaceFileCacheKey("w1", "/root");
    setWorkspaceFileSnapshot(cacheKey, ["a.ts", "b.ts"]);
    invalidateWorkspaceFileSnapshot("w1", "/root");
    assert.strictEqual(getWorkspaceFileSnapshot(cacheKey), null);
  });
});
