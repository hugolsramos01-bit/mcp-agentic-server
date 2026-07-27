import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkspaceStore", () => {
  let stateDir: string;
  let store: SqliteWorkspaceStore;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agentic-test-store-"));
    store = new SqliteWorkspaceStore(stateDir);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("delete with pending touch avoids flush", async () => {
    const s = store.createSession({ id: "ws1", root: "/tmp/ws1" });

    store.touchSession(s.id);
    store.deleteSession(s.id);

    // Give it time if there was a rogue async flush (there shouldn't be)
    store.close(); // forces flush
    
    // Reopen strictly to read
    const newStore = new SqliteWorkspaceStore(stateDir);
    const fetched = newStore.getSession(s.id);
    newStore.close();
    
    assert.strictEqual(fetched, undefined, "Session should be deleted");
  });

  test("updateStatus with pending touch avoids duplicate updates", async () => {
    const s = store.createSession({ id: "ws2", root: "/tmp/ws2" });
    
    store.touchSession(s.id);
    await delay(100);
    store.updateStatus(s.id, "archived");

    store.close();
    
    const newStore = new SqliteWorkspaceStore(stateDir);
    const fetched = newStore.getSession(s.id);
    newStore.close();
    
    assert.ok(fetched);
    assert.strictEqual(fetched.status, "archived");
  });

  test("periodic flush occurs", async () => {
    const s = store.createSession({ id: "ws3", root: "/tmp/ws3" });
    const origLastUsedAt = s.lastUsedAt;
    
    store.touchSession(s.id);
    store.close();
    
    const newStore = new SqliteWorkspaceStore(stateDir);
    const fetched = newStore.getSession(s.id);
    newStore.close();
    
    assert.ok(fetched);
    assert.notStrictEqual(fetched.lastUsedAt, origLastUsedAt, "lastUsedAt should be updated after close flush");
  });
});
