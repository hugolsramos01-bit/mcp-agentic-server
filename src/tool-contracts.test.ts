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
      "taskContext",
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

  it("readMany contract specifies composite inspection, ordered priority, and shared budgets", () => {
    const desc = TOOL_CONTRACTS.readMany.description;
    assert.ok(desc.includes("one round trip"), "Must emphasize batching related inspection");
    assert.ok(desc.includes("lexical matches"), "Must expose match+context capability");
    assert.ok(desc.includes("scoped globs"), "Must expose scoped glob capability");
    assert.ok(desc.includes("Items execute in order as priority"), "Must define ordered priority semantics");
    assert.ok(desc.includes("shared serialized-evidence, line, and file budgets"), "Must describe all shared budgets");
    assert.ok(desc.includes("final payload cost is estimated separately"), "Must distinguish evidence budget from envelope overhead");
    assert.ok(desc.includes("regex is an explicitly bounded opt-in"), "Must describe bounded regex semantics");
    assert.ok(desc.includes("not for project-wide architectural discovery"), "Must bound broad discovery");
  });

  it("semanticPack contract reserves broad discovery for genuinely unknown architecture", () => {
    const desc = TOOL_CONTRACTS.semanticPack.description;
    assert.ok(desc.includes("broad domain structure"), "Must reserve use for broad architecture");
    assert.ok(desc.includes("goal-focused"), "Must mention 'goal-focused'");
    assert.ok(desc.includes("stop architectural discovery"), "Must tell the model when to stop expanding scope");
    assert.ok(desc.includes("sufficient implementation targets are known"), "Must stop broad discovery after targets are known");
    assert.ok(desc.includes("composite inspection"), "Must hand off from broad discovery to narrower inspection");
  });

  it("grep contract specifies lexical search and limits semantic expectations", () => {
    const desc = TOOL_CONTRACTS.grep.description;
    assert.ok(desc.includes("lexically"), "Must mention lexical search");
    assert.ok(desc.includes("does not infer semantic dependencies"), "Must explicitly limit semantic capabilities");
  });

  it("readAdaptive contract defines boundaries vs read", () => {
    const desc = TOOL_CONTRACTS.readAdaptive.description;
    assert.ok(!desc.includes("Always use this instead"), "Should not aggressively override other tools");
    assert.ok(desc.includes("whole-file orientation"), "Must bound usage to whole-file orientation");
    assert.ok(desc.includes("obtain exact source text before changing"), "Must require authoritative text before editing omitted regions");
  });

  it("suggestChecks contract defines proportional staging without redundant QUICK calls", () => {
    const desc = TOOL_CONTRACTS.suggestChecks.description;
    assert.ok(desc.includes("does not execute checks"), "Must state it doesn't execute");
    assert.ok(desc.includes("after material code or configuration changes"), "Must clarify when to use");
    assert.ok(desc.includes("QUICK low-risk"), "Must allow direct obvious QUICK verification");
    assert.ok(desc.includes("staged cheap-first"), "Must prioritize cheap checks first");
    assert.ok(desc.includes("builds are reserved"), "Must not imply full builds for every code change");
  });

  it("taskContext contract defines minimal, stateless, goal-directed map", () => {
    const desc = TOOL_CONTRACTS.taskContext.description;
    assert.ok(desc.includes("minimal"), "Must mention 'minimal'");
    assert.ok(desc.includes("stateless"), "Must mention 'stateless'");
    assert.ok(desc.includes("goal-directed"), "Must mention 'goal-directed'");
    assert.ok(desc.includes("token budget"), "Must mention token budget");
    assert.ok(desc.includes("Skip this discovery step when the target file is already known"), "Must skip discovery for an already-known target");
  });

  it("avoids canonical tool-name cross references that inflate schema discovery", () => {
    const canonicalNames = [
      "read_adaptive",
      "read_compressed",
      "read_many",
      "semantic_pack",
      "task_context",
      "coding_context",
      "suggest_checks",
      "workspace_summary",
      "project_bootstrap",
      "show_changes",
      "checkpoint_restore",
      "checkpoint_save",
      "edit_dry_run",
    ];
    for (const [key, contract] of Object.entries(TOOL_CONTRACTS)) {
      for (const toolName of canonicalNames) {
        assert.ok(!contract.description.includes(toolName), `${key} description should not cross-reference ${toolName}`);
      }
    }
  });
});
