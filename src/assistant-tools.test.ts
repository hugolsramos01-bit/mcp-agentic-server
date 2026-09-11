import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runScriptTool, readManyTool } from "./assistant-tools.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync, truncateSync } from "fs";
import { execFileSync } from "node:child_process";
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

  it("does not expose Agentic control-plane env to package scripts", async () => {
    const testCwd = join(cwd, "agentic-env-isolation-" + Math.random().toString(36).slice(2));
    mkdirSync(testCwd, { recursive: true });
    writeFileSync(join(testCwd, "print-env.js"), `console.log(JSON.stringify({port:process.env.PORT??null,host:process.env.HOST??null,owner:process.env.AGENTIC_OAUTH_OWNER_TOKEN??null,workspaceId:process.env.AGENTIC_WORKSPACE_ID??null}));`);
    writeFileSync(join(testCwd, "package.json"), JSON.stringify({ scripts: { envcheck: "node print-env.js" } }));

    const previous = {
      PORT: process.env.PORT,
      HOST: process.env.HOST,
      AGENTIC_OAUTH_OWNER_TOKEN: process.env.AGENTIC_OAUTH_OWNER_TOKEN,
    };
    process.env.PORT = "7676";
    process.env.HOST = "127.0.0.1";
    process.env.AGENTIC_OAUTH_OWNER_TOKEN = "owner-secret";
    try {
      const result = await runScriptTool(
        { script: "envcheck", outputMode: "full" },
        testCwd,
        "safe",
        { serverHost: "127.0.0.1", serverPort: 7676, workspaceId: "ws_script" },
      );
      assert.notEqual(result.isError, true);
      const text = (result.content[0] as any).text as string;
      assert.match(text, /\\?"port\\?":null/);
      assert.match(text, /\\?"host\\?":null/);
      assert.match(text, /\\?"owner\\?":null/);
      assert.match(text, /ws_script/);
      assert.doesNotMatch(text, /owner-secret/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

// ─── readManyTool composite inspection and budget validation ─────────

describe("readManyTool — composite inspection", () => {
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
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
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

  it("uses a bounded 12k-token default budget", async () => {
    const largeFile = "large-default-budget.ts";
    writeFileSync(join(TMP, largeFile), "x".repeat(48_100), "utf8");

    const result = await readManyTool({ items: [{ path: largeFile }] }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, false);
    assert.equal(data.files.length, 0);
    assert.equal(data.skipped[0]?.code, "budget_exceeded");
    assert.equal(data.warning, "budget_exhausted");
  });

  it("allows an explicit larger budget when broad context is intentional", async () => {
    const largeFile = "large-explicit-budget.ts";
    writeFileSync(join(TMP, largeFile), "x".repeat(48_100), "utf8");

    const result = await readManyTool({
      items: [{ path: largeFile }],
      maxTokens: 16_000,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.files.length, 1);
    assert.equal(data.skipped.length, 0);
  });

  it("matches a regex with bounded context and merges overlapping windows", async () => {
    const result = await readManyTool({
      items: [{
        operation: "match",
        path: FILE,
        pattern: "beta|gamma",
        matchMode: "regex",
        beforeLines: 1,
        afterLines: 1,
        maxMatches: 10,
      }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, false);
    assert.equal(data.matches.length, 1);
    assert.equal(data.matches[0].matchCount, 2);
    assert.equal(data.matches[0].regions.length, 1, "overlapping match context must be de-duplicated");
    assert.deepEqual(data.matches[0].regions[0].matchedLines, [2, 3]);
    assert.equal(data.matches[0].regions[0].startLine, 1);
    assert.equal(data.matches[0].regions[0].endLine, 4);
  });

  it("matches recursively inside a scoped directory", async () => {
    mkdirSync(join(TMP, "src", "nested"), { recursive: true });
    writeFileSync(join(TMP, "src", "one.ts"), "const marker = 'TARGET';\n", "utf8");
    writeFileSync(join(TMP, "src", "nested", "two.ts"), "// TARGET\n", "utf8");
    writeFileSync(join(TMP, "outside.ts"), "// TARGET\n", "utf8");

    const result = await readManyTool({
      items: [{
        operation: "match",
        path: "src",
        pattern: "TARGET",
        matchMode: "literal",
        maxMatches: 10,
      }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);
    const paths = data.matches[0].regions.map((region: any) => region.path).sort();

    assert.deepEqual(paths, ["src/nested/two.ts", "src/one.ts"]);
    assert.equal(data.matches[0].matchCount, 2);
  });

  it("returns scoped glob results without reading file contents", async () => {
    mkdirSync(join(TMP, "src", "nested"), { recursive: true });
    writeFileSync(join(TMP, "src", "one.ts"), "one", "utf8");
    writeFileSync(join(TMP, "src", "nested", "two.ts"), "two", "utf8");
    writeFileSync(join(TMP, "src", "nested", "skip.js"), "skip", "utf8");

    const result = await readManyTool({
      items: [{ operation: "glob", path: "src", glob: "**/*.ts", maxFiles: 10 }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.globs.length, 1);
    assert.deepEqual(data.globs[0].files.sort(), ["src/nested/two.ts", "src/one.ts"]);
    assert.equal(data.files.length, 0);
  });

  it("returns as many glob paths as fit instead of dropping the whole glob on shared file budget", async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "first.ts"), "first", "utf8");
    writeFileSync(join(TMP, "src", "a.ts"), "a", "utf8");
    writeFileSync(join(TMP, "src", "b.ts"), "b", "utf8");

    const result = await readManyTool({
      items: [
        { path: "first.ts" },
        { operation: "glob", path: "src", glob: "*.ts", maxFiles: 10 },
      ],
      maxFiles: 2,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.files.length, 1);
    assert.equal(data.globs.length, 1);
    assert.equal(data.globs[0].files.length, 1);
    assert.equal(data.globs[0].truncated, true);
    assert.equal(data.budget.usedFiles, 2);
  });

  it("uses item order as priority under the shared line budget", async () => {
    const result = await readManyTool({
      items: [
        { path: FILE, startLine: 1, endLine: 1 },
        { path: FILE, startLine: 2, endLine: 2 },
      ],
      maxLines: 1,
      maxTokens: 100,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].content.trim(), LINES[0]);
    assert.equal(data.skipped[0]?.code, "line_budget_exceeded");
    assert.equal(data.budget.usedLines, 1);
  });

  it("enforces a shared unique-file budget across operations", async () => {
    writeFileSync(join(TMP, "second.ts"), "export const second = true;", "utf8");
    const result = await readManyTool({
      items: [
        { path: FILE, startLine: 1, endLine: 1 },
        { path: "second.ts", startLine: 1, endLine: 1 },
      ],
      maxFiles: 1,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.files.length, 1);
    assert.equal(data.skipped[0]?.code, "file_budget_exceeded");
    assert.equal(data.budget.usedFiles, 1);
  });

  it("returns a successful empty match result instead of treating no matches as failure", async () => {
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "DOES_NOT_EXIST", matchMode: "literal" }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, false);
    assert.equal(data.matches[0].matchCount, 0);
    assert.deepEqual(data.matches[0].regions, []);
  });

  it("treats match patterns as literal by default", async () => {
    writeFileSync(FULL_PATH, ["literal beta|gamma", "beta only"].join("\n"), "utf8");
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "beta|gamma" }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.matches[0].matchMode, "literal");
    assert.equal(data.matches[0].matchCount, 1);
  });

  it("fails closed on an invalid explicit regex without affecting other item modes", async () => {
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "[unterminated", matchMode: "regex" }],
    }, TMP, [TMP]);

    assert.equal(result.isError, true);
    assert.match((result.content[0] as any).text, /invalid regular expression|unterminated/i);
  });

  it("rejects incompatible fields instead of guessing an ambiguous operation", async () => {
    const result = await readManyTool({
      items: [{ operation: "read", path: FILE, pattern: "alpha" }],
    }, TMP, [TMP]);

    assert.equal(result.isError, true);
    assert.match((result.content[0] as any).text, /read operation cannot include pattern/i);
  });

  it("keeps composite inspection inside the allowed workspace root", async () => {
    const result = await readManyTool({
      items: [{ operation: "glob", path: "..", glob: "**/*.ts" }],
    }, TMP, [TMP]);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.data?.skipped?.length, 1);
  });

  it("rejects oversized item batches before doing any filesystem work", async () => {
    await assert.rejects(
      readManyTool({ items: Array.from({ length: 101 }, () => ({ path: FILE })) }, TMP, [TMP]),
      /at most 100 items/i,
    );
  });

  it("rejects oversized match patterns", async () => {
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "x".repeat(501) }],
    }, TMP, [TMP]);
    assert.equal(result.isError, true);
    assert.match((result.content[0] as any).text, /pattern must be <= 500 characters/i);
  });

  it("charges serialized result metadata against the shared token budget", async () => {
    const result = await readManyTool({
      items: [{ path: FILE, startLine: 1, endLine: 1 }],
      maxTokens: 20,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.files.length, 0);
    assert.equal(data.skipped[0]?.code, "budget_exceeded");
    assert.ok(data.budget.estimatedPayloadTokens >= data.budget.usedTokens);
    assert.ok(data.budget.envelopeOverheadTokens > 0);
  });

  it("charges base metadata for empty match results so many no-match items cannot bypass the budget", async () => {
    const result = await readManyTool({
      items: Array.from({ length: 20 }, () => ({ operation: "match" as const, path: FILE, pattern: "DOES_NOT_EXIST" })),
      maxTokens: 200,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.ok(data.matches.length > 0 && data.matches.length < 20);
    assert.ok((data.skipCounts.budget_exceeded ?? 0) > 0);
    assert.ok(data.budget.usedTokens <= data.budget.maxTokens);
  });

  it("bounds skipped diagnostics while preserving complete skip counters", async () => {
    const result = await readManyTool({
      items: Array.from({ length: 20 }, () => ({ path: FILE, startLine: 1 })),
      maxTokens: 200,
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, true);
    assert.equal(data.skipped.length, 1);
    assert.equal(data.skippedOmitted, 19);
    assert.equal(data.skipCounts.invalid_range, 20);
  });

  it("rejects explicit regex constructs with obvious catastrophic-backtracking risk", async () => {
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "(a+)+$", matchMode: "regex" }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, true);
    assert.equal(data.skipped[0]?.code, "invalid_pattern");
    assert.match(data.skipped[0]?.reason ?? "", /backtracking/i);
  });

  it("applies include globs to both directory and file-scoped matches", async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src", "one.ts"), "// TARGET\n", "utf8");
    writeFileSync(join(TMP, "src", "two.js"), "// TARGET\n", "utf8");

    const result = await readManyTool({
      items: [
        { operation: "match", path: "src", pattern: "TARGET", include: "**/*.ts" },
        { operation: "match", path: "src/one.ts", pattern: "TARGET", include: "*.ts" },
      ],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.deepEqual(data.matches[0].regions.map((region: any) => region.path), ["src/one.ts"]);
    assert.deepEqual(data.matches[1].regions.map((region: any) => region.path), ["src/one.ts"]);
  });

  it("skips exceptionally long lines for explicit regex evaluation", async () => {
    writeFileSync(FULL_PATH, `${"a".repeat(40_000)}TARGET`, "utf8");
    const result = await readManyTool({
      items: [{ operation: "match", path: FILE, pattern: "TARGET$", matchMode: "regex" }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.matches[0].matchCount, 0);
    assert.equal(data.matches[0].skippedLongRegexLines, 1);
  });

  it("does not fall back to ignored files when git returns an empty scoped listing", async () => {
    mkdirSync(join(TMP, "ignored"), { recursive: true });
    writeFileSync(join(TMP, ".gitignore"), "ignored/\n", "utf8");
    writeFileSync(join(TMP, "ignored", "secret.ts"), "// TARGET\n", "utf8");
    execFileSync("git", ["init"], { cwd: TMP, stdio: "ignore" });

    const result = await readManyTool({
      items: [{ operation: "match", path: "ignored", pattern: "TARGET" }],
    }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(data.matches[0].matchCount, 0);
    assert.deepEqual(data.matches[0].regions, []);
  });

  it("rejects fields that belong to a different composite operation instead of silently ignoring them", async () => {
    const cases = [
      { item: { operation: "read" as const, path: FILE, include: "*.ts" }, field: "include" },
      { item: { operation: "match" as const, path: FILE, pattern: "alpha", maxFiles: 2 }, field: "maxFiles" },
      { item: { operation: "glob" as const, path: ".", glob: "*.ts", beforeLines: 3 }, field: "beforeLines" },
    ];

    for (const { item, field } of cases) {
      const result = await readManyTool({ items: [item] }, TMP, [TMP]);
      const data = JSON.parse((result.content[0] as any).text);
      assert.equal(result.isError, true, `${field} must fail closed`);
      assert.equal(data.skipped[0]?.code, "invalid_item");
      assert.match(data.skipped[0]?.reason ?? "", new RegExp(field, "i"));
    }
  });

  it("preserves legacy paths mode for existing callers", async () => {
    const result = await readManyTool({ paths: [FILE] }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, false);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].operation, "read");
    assert.ok(data.files[0].content.includes("alpha"));
  });

  it("rejects oversized paths before filesystem resolution", async () => {
    const result = await readManyTool({ items: [{ path: "x".repeat(4_097) }] }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, true);
    assert.equal(data.skipped[0]?.code, "invalid_item");
    assert.match(data.skipped[0]?.reason ?? "", /path must be <= 4096 characters/i);
    assert.ok((data.skipped[0]?.path?.length ?? 0) <= 512, "diagnostic path must stay bounded");
    assert.match(data.skipped[0]?.path ?? "", /diagnostic truncated/);
  });

  it("rejects huge composite-read files before loading their contents", async () => {
    const hugeFile = "huge.ts";
    const hugePath = join(TMP, hugeFile);
    writeFileSync(hugePath, "", "utf8");
    truncateSync(hugePath, 32 * 1024 * 1024 + 1);

    const result = await readManyTool({ items: [{ path: hugeFile, startLine: 1, endLine: 1 }] }, TMP, [TMP]);
    const data = JSON.parse((result.content[0] as any).text);

    assert.equal(result.isError, true);
    assert.equal(data.skipped[0]?.code, "resource_limit");
    assert.match(data.skipped[0]?.reason ?? "", /too large for composite read/i);
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
