import { describe, it } from "node:test";
import assert from "node:assert";
import { formatMutationReceipt, MutationReceiptInput } from "./mutation-receipt.js";

describe("Mutation Receipt", () => {
  it("formats a standard receipt with additions and removals", async () => {
    const files: MutationReceiptInput[] = [
      { path: "src/index.ts", operation: "update", additions: 5, removals: 2, afterHash: "a1b2c3d4" }
    ];
    const receipt = await formatMutationReceipt("/mock/workspace", files);
    assert.ok(receipt.includes("### Mutation Receipt"));
    assert.ok(receipt.includes("- **src/index.ts** (update)"));
    assert.ok(receipt.includes("- Hash: `a1b2c3d4`"));
    assert.ok(receipt.includes("- Changes: +5, -2"));
  });

  it("returns empty string if no files provided", async () => {
    const receipt = await formatMutationReceipt("/mock/workspace", []);
    assert.strictEqual(receipt, "");
  });
});
