import { describe, it } from "node:test";
import assert from "node:assert";
import { TOOL_CONTRACTS } from "./tool-contracts.js";

describe("TOOL_CONTRACTS", () => {
  it("has all expected contracts", () => {
    const expectedKeys = [
      "read",
      "readAdaptive",
      "readCompressed",
      "readMany",
      "grep",
      "semanticPack",
      "codingContext",
      "suggestChecks"
    ];
    for (const key of expectedKeys) {
      assert.ok((TOOL_CONTRACTS as Record<string, any>)[key], `Missing contract for ${key}`);
      assert.ok(typeof (TOOL_CONTRACTS as Record<string, any>)[key].title === "string");
      assert.ok(typeof (TOOL_CONTRACTS as Record<string, any>)[key].description === "string");
    }
  });

  it("respects character budget and specific assertions", () => {
    for (const [key, contract] of Object.entries(TOOL_CONTRACTS)) {
      assert.ok(contract.description.length <= 600, `Description for ${key} exceeds 600 characters (${contract.description.length})`);
    }
  });

  it("readMany contract specifies already-known files and token budget constraints", () => {
    const desc = TOOL_CONTRACTS.readMany.description;
    assert.ok(desc.includes("already-known files"), "Must mention 'already-known files'");
    assert.ok(desc.includes("shared token budget"), "Must mention 'shared token budget'");
    assert.ok(desc.includes("may be skipped"), "Must mention 'may be skipped'");
    assert.ok(desc.includes("Do not use this tool to discover"), "Must mention not for discovery");
  });

  it("semanticPack contract specifies target is unknown files and token budget", () => {
    const desc = TOOL_CONTRACTS.semanticPack.description;
    assert.ok(desc.includes("relevant files are not yet known"), "Must mention 'relevant files are not yet known'");
    assert.ok(desc.includes("goal-focused"), "Must mention 'goal-focused'");
    assert.ok(desc.includes("token budget"), "Must mention 'token budget'");
    assert.ok(desc.includes("Once the primary files are known, prefer"), "Must guide transition to other tools");
  });

  it("grep contract specifies lexical search and limits semantic expectations", () => {
    const desc = TOOL_CONTRACTS.grep.description;
    assert.ok(desc.includes("lexically"), "Must mention lexical search");
    assert.ok(desc.includes("does not infer semantic dependencies"), "Must explicitly limit semantic capabilities");
  });

  it("readAdaptive contract defines boundaries vs read", () => {
    const desc = TOOL_CONTRACTS.readAdaptive.description;
    assert.ok(!desc.includes("Always use this instead"), "Should not aggressively override other tools");
    assert.ok(desc.includes("when exact line ranges are not required"), "Must bound usage against exact reads");
    assert.ok(desc.includes("read the relevant range with read before changing it"), "Must enforce safe edits");
  });

  it("suggestChecks contract defines staging and validation without execution", () => {
    const desc = TOOL_CONTRACTS.suggestChecks.description;
    assert.ok(desc.includes("recommends checks but does not execute them"), "Must state it doesn't execute");
    assert.ok(desc.includes("Use after material code or configuration changes"), "Must clarify when to use");
  });
});
