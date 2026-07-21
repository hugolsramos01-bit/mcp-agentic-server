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
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it("should enforce the provided timeoutMs", async () => {
    // Setup a script that sleeps for 2 seconds
    const cwd = join(tmpdir(), "agentic-test-timeout-" + Math.random().toString(36).slice(2));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: {
        "long-task": "node -e \"setTimeout(() => console.log('done'), 2000)\""
      }
    }));

    const result = await runScriptTool({ script: "long-task", outputMode: "summary", timeoutMs: 1000 }, cwd);
    
    assert.equal(result.isError, undefined, "timeout is not an infrastructure error");
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "timeout");
    assert.match(parsed.summary, /timed out after 1\d{3}ms/);
    assert.equal(parsed.timeoutMs, 1000);
  });
});
