import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFilesTool, runShellTool } from "./pi-tools.js";

function withTempWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "agentic-pi-tools-test-"));
  return fn(root).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("grep excludes internal checkpoint metadata and secret-like files", async () => {
  await withTempWorkspace(async (root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".git", "agentic-checkpoints", "cp", "untracked"), { recursive: true });
    writeFileSync(join(root, "src", "visible.ts"), "export const value = 'AGENTIC_GREP_MARKER';\n", "utf8");
    writeFileSync(join(root, ".git", "agentic-checkpoints", "cp", "untracked", "hidden.ts"), "AGENTIC_GREP_MARKER\n", "utf8");
    writeFileSync(join(root, ".env"), "SECRET=AGENTIC_GREP_MARKER\n", "utf8");
    writeFileSync(join(root, "private.pem"), "AGENTIC_GREP_MARKER\n", "utf8");

    const result = await grepFilesTool(
      { pattern: "AGENTIC_GREP_MARKER", path: root, literal: true } as any,
      { cwd: root, root, workspaceId: "ws_grep", serverHost: "127.0.0.1", serverPort: 7676 } as any,
    );

    assert.equal(result.isError, undefined);
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.match(text, /src[\\/]visible\.ts|src\/visible\.ts/i);
    assert.doesNotMatch(text, /agentic-checkpoints/i);
    assert.doesNotMatch(text, /\.env/i);
    assert.doesNotMatch(text, /private\.pem/i);
  });
});

test("grep include glob is applied by the structured wrapper", async () => {
  await withTempWorkspace(async (root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "one.ts"), "FILTER_MARKER\n", "utf8");
    writeFileSync(join(root, "src", "two.js"), "FILTER_MARKER\n", "utf8");

    const result = await grepFilesTool(
      { pattern: "FILTER_MARKER", path: join(root, "src"), include: "**/*.ts", literal: true } as any,
      { cwd: root, root, workspaceId: "ws_grep", serverHost: "127.0.0.1", serverPort: 7676 } as any,
    );

    assert.equal(result.isError, undefined);
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.match(text, /one\.ts/i);
    assert.doesNotMatch(text, /two\.js/i);
  });
});

test("grep security exclusions take precedence over caller include globs", async () => {
  await withTempWorkspace(async (root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "visible.ts"), "SECRET_OVERRIDE_MARKER\n", "utf8");
    writeFileSync(join(root, ".env"), "SECRET_OVERRIDE_MARKER\n", "utf8");

    const result = await grepFilesTool(
      { pattern: "SECRET_OVERRIDE_MARKER", path: root, include: "**/.env", literal: true } as any,
      { cwd: root, root, workspaceId: "ws_grep", serverHost: "127.0.0.1", serverPort: 7676 } as any,
    );

    assert.equal(result.isError, undefined);
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.equal(text.trim(), "No matches found");
    assert.doesNotMatch(text, /\.env/i);
  });
});

test("shell does not expose Agentic control-plane variables or legacy server binding", async () => {
  await withTempWorkspace(async (root) => {
    const script = join(root, "print-env.cjs");
    writeFileSync(script, `console.log(JSON.stringify({\n  port: process.env.PORT ?? null,\n  host: process.env.HOST ?? null,\n  owner: process.env.AGENTIC_OAUTH_OWNER_TOKEN ?? null,\n  roots: process.env.AGENTIC_ALLOWED_ROOTS ?? null,\n  publicUrl: process.env.AGENTIC_PUBLIC_BASE_URL ?? null,\n  workspaceId: process.env.AGENTIC_WORKSPACE_ID ?? null,\n  workspaceRoot: process.env.AGENTIC_WORKSPACE_ROOT ?? null\n}));\n`, "utf8");

    const previous = {
      PORT: process.env.PORT,
      HOST: process.env.HOST,
      AGENTIC_OAUTH_OWNER_TOKEN: process.env.AGENTIC_OAUTH_OWNER_TOKEN,
      AGENTIC_ALLOWED_ROOTS: process.env.AGENTIC_ALLOWED_ROOTS,
      AGENTIC_PUBLIC_BASE_URL: process.env.AGENTIC_PUBLIC_BASE_URL,
    };
    process.env.PORT = "7676";
    process.env.HOST = "127.0.0.1";
    process.env.AGENTIC_OAUTH_OWNER_TOKEN = "owner-secret";
    process.env.AGENTIC_ALLOWED_ROOTS = root;
    process.env.AGENTIC_PUBLIC_BASE_URL = "https://agentic.example";

    try {
      const result = await runShellTool(
        { command: "node print-env.cjs", timeout: 10 } as any,
        {
          cwd: root,
          root,
          securityMode: "trusted",
          workspaceId: "ws_shell",
          serverHost: "127.0.0.1",
          serverPort: 7676,
        } as any,
      );

      assert.equal(result.isError, undefined);
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const jsonLine = text.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
      assert.ok(jsonLine, `Expected JSON output, got: ${text}`);
      const data = JSON.parse(jsonLine);
      assert.deepEqual(data, {
        port: null,
        host: null,
        owner: null,
        roots: null,
        publicUrl: null,
        workspaceId: "ws_shell",
        workspaceRoot: root,
      });
    } finally {
      restoreEnv("PORT", previous.PORT);
      restoreEnv("HOST", previous.HOST);
      restoreEnv("AGENTIC_OAUTH_OWNER_TOKEN", previous.AGENTIC_OAUTH_OWNER_TOKEN);
      restoreEnv("AGENTIC_ALLOWED_ROOTS", previous.AGENTIC_ALLOWED_ROOTS);
      restoreEnv("AGENTIC_PUBLIC_BASE_URL", previous.AGENTIC_PUBLIC_BASE_URL);
    }
  });
});
