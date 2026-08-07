import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runScriptTool, readManyTool } from "./assistant-tools.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";

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

  it("security modes control inline package-script execution", async () => {
    const testCwd = join(cwd, "agentic-security-mode-script-" + Math.random().toString(36).slice(2));
    mkdirSync(testCwd, { recursive: true });
    writeFileSync(join(testCwd, "package.json"), JSON.stringify({
      scripts: {
        inline: "node -e \"console.log('inline-ok')\"",
      },
    }));

    const safe = await runScriptTool({ script: "inline", outputMode: "summary" }, testCwd, "safe");
    assert.equal(safe.isError, true);
    assert.equal(safe.structuredContent?.status, "policy_blocked");

    const trusted = await runScriptTool({ script: "inline", outputMode: "summary" }, testCwd, "trusted");
    assert.notEqual(trusted.isError, true);
    assert.match((trusted.content[0] as any).text, /inline-ok/);

    const full = await runScriptTool({ script: "inline", outputMode: "summary" }, testCwd, "full");
    assert.notEqual(full.isError, true);
    assert.match((full.content[0] as any).text, /inline-ok/);
  });

  it("full mode skips fail-closed nested-script policy parsing", async () => {
    const testCwd = join(cwd, "agentic-full-script-" + Math.random().toString(36).slice(2));
    mkdirSync(testCwd, { recursive: true });
    writeFileSync(join(testCwd, "package.json"), JSON.stringify({
      scripts: {
        target: "node -e \"console.log('target-ok')\"",
        wrapper: "npm --if-present run target",
      },
    }));

    const safe = await runScriptTool({ script: "wrapper", outputMode: "summary" }, testCwd, "safe");
    assert.equal(safe.isError, true);
    assert.match((safe.content[0] as any).text, /Unsupported (?:npm option|package-manager script syntax)/i);

    const full = await runScriptTool({ script: "wrapper", outputMode: "summary" }, testCwd, "full");
    assert.notEqual(full.isError, true);
    assert.match((full.content[0] as any).text, /target-ok/);
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

// ─── P3: readManyTool deduplication and range validation ─────────────

describe("readManyTool — P3 ranged reads", () => {
  const TMP = join(tmpdir(), `read-many-test-${process.pid}`);
  const FILE = "multi.ts";
  const FULL_PATH = join(TMP, FILE);
  const LINES = [
    "export function alpha() { return 1; }",   // line 1
    "export function beta() { return 2; }",    // line 2
    "export function gamma() { return 3; }",   // line 3
    "export function delta() { return 4; }",   // line 4
    "export function epsilon() { return 5; }", // line 5
  ];

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(FULL_PATH, LINES.join("\n"), "utf8");
    process.env.AGENTIC_ALLOWED_ROOTS = TMP;
  });

  it("reads 5 regions of the same file — only one actual read per file", async () => {
    // All items point to the same file. The dedup cache means we read it once.
    const result = await readManyTool({
      items: [
        { path: FILE, startLine: 1, endLine: 1 },
        { path: FILE, startLine: 2, endLine: 2 },
        { path: FILE, startLine: 3, endLine: 3 },
        { path: FILE, startLine: 4, endLine: 4 },
        { path: FILE, startLine: 5, endLine: 5 },
      ]
    }, TMP, [TMP]);

    const data = JSON.parse((result.content[0] as any).text);
    assert.equal(data.files.length, 5, "all 5 ranged items should succeed");
    assert.equal(data.skipped.length, 0, "nothing should be skipped");

    // Each item should return only its requested line
    assert.equal(data.files[0].content.trim(), LINES[0].trim());
    assert.equal(data.files[2].content.trim(), LINES[2].trim());
    assert.equal(data.files[4].content.trim(), LINES[4].trim());

    // All items share the same contentHash (same underlying file)
    const hashes = new Set(data.files.map((f: any) => f.contentHash));
    assert.equal(hashes.size, 1, "all regions of the same file must share one contentHash");
  });

  it("skips item with only startLine (missing endLine)", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, startLine: 1 }]
    }, TMP, [TMP]);

    const text = (result.content[0] as any).text;
    assert.equal(result.isError, true);
    assert.ok(text.includes("both startLine and endLine"));
  });

  it("skips item with only endLine (missing startLine)", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, endLine: 3 }]
    }, TMP, [TMP]);

    const text = (result.content[0] as any).text;
    assert.equal(result.isError, true);
    assert.ok(text.includes("both startLine and endLine"));
  });

  it("skips item where startLine > endLine", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, startLine: 5, endLine: 2 }]
    }, TMP, [TMP]);

    const text = (result.content[0] as any).text;
    assert.equal(result.isError, true);
    assert.ok(text.includes("must be <= endLine"));
  });

  it("skips item where startLine > totalLines", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, startLine: 999, endLine: 1000 }]
    }, TMP, [TMP]);

    const text = (result.content[0] as any).text;
    assert.equal(result.isError, true);
    assert.ok(text.includes("exceeds file length"));
  });

  it("skips item where startLine <= 0", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, startLine: 0, endLine: 3 }]
    }, TMP, [TMP]);

    const text = (result.content[0] as any).text;
    assert.equal(result.isError, true);
    assert.ok(text.includes(">= 1"));
  });

  it("reads full file when no range is given", async () => {
    const result = await readManyTool({ items: [{ path: FILE }] }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);
    assert.equal(data.files.length, 1);
    assert.ok(data.files[0].content.includes("alpha"));
    assert.ok(data.files[0].content.includes("epsilon"));
  });

  it("throws error if both paths and items are provided", async () => {
    await assert.rejects(
      readManyTool({ paths: [FILE], items: [{ path: FILE }] }, TMP, [TMP]),
      /read_many requires exactly one of 'paths' or 'items'\./
    );
  });

  it("throws error if neither paths nor items are provided", async () => {
    await assert.rejects(
      readManyTool({}, TMP, [TMP]),
      /read_many requires exactly one of 'paths' or 'items'\./
    );
  });
});
