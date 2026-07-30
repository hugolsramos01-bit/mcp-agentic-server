import { test, describe, before, after } from "node:test";
import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { getGitChangedPaths } from "./git-change-paths.js";

describe("getGitChangedPaths", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "git-test-"));
    // Init git
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd });

    // Initial commit
    writeFileSync(join(cwd, "initial.txt"), "hello");
    execFileSync("git", ["add", "initial.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd });
  });

  after(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch (e) {}
  });

  test("returns empty array for clean working tree", async () => {
    const paths = await getGitChangedPaths(cwd);
    assert.deepStrictEqual(paths, []);
  });

  test("detects unstaged modifications", async () => {
    writeFileSync(join(cwd, "initial.txt"), "hello world");
    const paths = await getGitChangedPaths(cwd);
    assert.deepStrictEqual(paths, ["initial.txt"]);
  });

  test("detects staged modifications", async () => {
    execFileSync("git", ["add", "initial.txt"], { cwd });
    const paths = await getGitChangedPaths(cwd);
    assert.deepStrictEqual(paths, ["initial.txt"]);
  });

  test("detects untracked files with spaces and unicode", async () => {
    writeFileSync(join(cwd, "file with spaces.txt"), "spaces");
    writeFileSync(join(cwd, "arquivo_ação.txt"), "unicode");
    
    const paths = await getGitChangedPaths(cwd);
    assert.ok(paths.includes("initial.txt"));
    assert.ok(paths.includes("file with spaces.txt"));
    assert.ok(paths.includes("arquivo_ação.txt"));
  });

  test("detects renames correctly", async () => {
    // Commit the current state
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "Second commit"], { cwd });

    // Rename a file using git mv
    execFileSync("git", ["mv", "initial.txt", "renamed.txt"], { cwd });
    
    const paths = await getGitChangedPaths(cwd);
    assert.ok(paths.includes("renamed.txt"));
    assert.strictEqual(paths.includes("initial.txt"), false);
  });
});
