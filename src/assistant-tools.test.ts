import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runScriptTool } from "./assistant-tools.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

describe("runScriptTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(process.cwd(), "test", "fixtures", "timeout-regression");
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    mkdirSync(cwd, { recursive: true });
    process.env.AGENTIC_ALLOWED_ROOTS = cwd;
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it("should enforce the provided timeoutMs", async () => {
    // Setup a script that sleeps for 2 seconds
    const testCwd = join(cwd, "agentic-test-timeout-" + Math.random().toString(36).slice(2));
    mkdirSync(testCwd, { recursive: true });
    writeFileSync(join(testCwd, "sleep.js"), "setTimeout(function(){console.log('done')}, 2000);");
    writeFileSync(join(testCwd, "package.json"), JSON.stringify({
      scripts: {
        "long-task": "node sleep.js"
      }
    }));

    const result = await runScriptTool({ script: "long-task", outputMode: "summary", timeoutMs: 1000 }, testCwd);
    
    assert.equal(result.isError, true, "timeout should be flagged as an error");
    const firstContent = result.content[0];
    assert.ok(firstContent && firstContent.type === "text", "timeout response should include text content");
    let parsed: any;
    try {
      parsed = JSON.parse(firstContent.text);
    } catch (e) {
      assert.fail(`Failed to parse response: ${firstContent.text}`);
    }
    assert.equal(parsed.status, "timeout");
    assert.equal(parsed.timeoutMs, 1000);
  });
});
