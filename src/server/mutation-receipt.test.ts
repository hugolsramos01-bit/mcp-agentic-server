import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateMutationReceipt, MutationReceiptInput } from "./mutation-receipt.js";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 1. Basic formatting tests
describe("Mutation Receipt Logic", () => {
  it("formats a standard receipt with additions and removals", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-mutation-"));
    const filePath = join(root, "index.ts");
    await writeFile(filePath, "console.log('hello');");
    
    // Create a mock nearby test
    await writeFile(join(root, "index.test.ts"), "test()");
    
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    
    const files: MutationReceiptInput[] = [
      { path: "index.ts", operation: "update", additions: 5, removals: 2, beforeHash: "oldhash123", afterHash: "a1b2c3d4" }
    ];
    
    const receipt = await generateMutationReceipt(root, files);
    assert.ok(receipt);
    assert.equal(receipt.version, 1);
    assert.equal(receipt.files.length, 1);
    assert.equal(receipt.files[0].path, "index.ts");
    assert.equal(receipt.files[0].operation, "update");
    assert.equal(receipt.files[0].additions, 5);
    assert.equal(receipt.files[0].beforeHash, "sha256:oldhash123");
    assert.equal(receipt.files[0].afterHash, "sha256:a1b2c3d4");
    assert.ok(receipt.files[0].nearbyTestCandidates.includes("index.test.ts"));
  });

  it("returns null if no files provided", async () => {
    const receipt = await generateMutationReceipt("/mock/workspace", []);
    assert.strictEqual(receipt, null);
  });
});
