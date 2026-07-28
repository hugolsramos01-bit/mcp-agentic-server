import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile, cp, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEMP_DIR = join(ROOT, ".tmp-runtime-test");

const exec = promisify((await import("node:child_process")).exec);

async function run() {
  console.log("Preparing environment...");
  await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEMP_DIR, { recursive: true });

  const fixtureRepo = join(TEMP_DIR, "fixture-repo");
  await mkdir(fixtureRepo);
  await mkdir(join(fixtureRepo, "src"));
  await mkdir(join(fixtureRepo, "excluded"));
  await mkdir(join(fixtureRepo, "tests"));

  await writeFile(join(fixtureRepo, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(join(fixtureRepo, "src/auth.ts"), "export const auth = true;");
  await writeFile(join(fixtureRepo, "src/other.ts"), "export const other = true;");
  await writeFile(join(fixtureRepo, "excluded/secret.ts"), "export const secret = true;");
  await writeFile(join(fixtureRepo, "tests/auth.test.ts"), "import '../src/auth.ts';");

  await exec(`git init`, { cwd: fixtureRepo });
  await exec(`git config user.email runtime@test.local`, { cwd: fixtureRepo });
  await exec(`git config user.name "Runtime Test"`, { cwd: fixtureRepo });
  await exec(`git add .`, { cwd: fixtureRepo });
  await exec(`git commit -m "fixture"`, { cwd: fixtureRepo });

  console.log("Packing project...");
  const { stdout: packOut } = await exec(`npm pack`, { cwd: ROOT });
  const tarballName = packOut.trim().split("\n").pop().trim();
  const tarballPath = join(ROOT, tarballName);

  const installDir = join(TEMP_DIR, "install-env");
  await mkdir(installDir);
  await writeFile(join(installDir, "package.json"), JSON.stringify({ name: "test-env" }));

  console.log(`Installing ${tarballName}...`);
  await exec(`npm install ${tarballPath}`, { cwd: installDir });

  const installedCliPath = join(installDir, "node_modules", "mcp-agentic-server", "dist", "cli.js");
  const stateDirectory = join(TEMP_DIR, "state");
  await mkdir(stateDirectory);

  console.log("Starting MCP client...");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [installedCliPath, "stdio"],
    env: {
      ...process.env,
      AGENTIC_ALLOWED_ROOTS: fixtureRepo,
      AGENTIC_STATE_DIR: stateDirectory,
      AGENTIC_TOOL_MODE: "assistant",
      AGENTIC_REQUIRE_IF_MATCH: "existing",
    },
  });

  const client = new Client({ name: "runtime-hotfix-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("MCP Client connected.");
  
  async function callTool(name, args = {}) {
    return await client.callTool({ name, arguments: args });
  }

  try {
    console.log("1. Initialize Workspace");
    const ws = await callTool("open_workspace", { path: fixtureRepo, mode: "worktree" });
    console.log("ws:", JSON.stringify(ws, null, 2));
    const workspaceId = ws.structuredContent?.workspaceId || ws.content.find((c) => c.type === "text")?.text.match(/Opened workspace (ws_[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)/)?.[1] || "default";
    console.log("Extracted workspaceId:", workspaceId);

    console.log("2. task_context: Directory Focus & Exclusions");
    const tc1 = await callTool("task_context", {
      workspaceId,
      goal: "Analyze auth",
      focusPaths: ["src"],
      excludePaths: ["excluded"]
    });
    
    const tc1Text = JSON.stringify(tc1.structuredContent || tc1);
    assert(!tc1Text.includes("excluded/secret.ts"), "Excluded file should not be present");
    assert(tc1Text.includes("tests/auth.test.ts"), "Tests should be in context since they depend on focused files");

    console.log("3. read_many: Success and Errors");
    const rm1 = await callTool("read_many", {
      workspaceId,
      paths: ["src/auth.ts", "src/missing.ts"]
    });
    console.log("rm1:", rm1);
    
    assert(rm1.isError !== true, "read_many should be success if at least one file is read");
    const rmData = rm1.structuredContent?.data;
    assert(rmData.files.length === 1, "Should have 1 file");
    assert(rmData.skipped.length === 1, "Should have 1 skipped");
    console.log("rmData.skipped:", rmData.skipped);
    assert(rmData.skipped[0].reason === "path_resolution_failed", "Reason should be path_resolution_failed");
    const authHash = rmData.files[0].contentHash;

    const rm2 = await callTool("read_many", {
      workspaceId,
      paths: ["src/missing1.ts", "src/missing2.ts"]
    }).catch(e => e);
    console.log("rm2:", rm2);
    
    assert(rm2.code || rm2.isError, "read_many should return error when all files fail");

    console.log("4. edit: Success and ifMatch");
    const edit1 = await callTool("edit", {
      workspaceId,
      path: "src/auth.ts",
      edits: [{ oldText: "export const auth = true;", newText: "export const auth = false;" }],
      ifMatch: authHash
    });
    
    assert(!edit1.isError, "Edit should succeed");
    
    const edit2 = await callTool("edit", {
      workspaceId,
      path: "src/auth.ts",
      edits: [{ oldText: "export const auth = false;", newText: "export const auth = true;" }],
      ifMatch: authHash // old hash
    }).catch(e => {
       // if MCP SDK parses the error envelop, it might throw an RPC error
       return { isError: true, message: e.message };
    });
    assert(edit2.isError || edit2.code, "Edit should fail with file_version_conflict");

    console.log("5. write: file_version_conflict");
    const write1 = await callTool("write", {
      workspaceId,
      path: "src/new.ts",
      content: "export const n = 1;",
      ifMatch: null
    });
    assert(!write1.isError, "Write new file should succeed");

    const write2 = await callTool("write", {
      workspaceId,
      path: "src/new.ts",
      content: "export const n = 2;",
      ifMatch: null
    }).catch(e => ({ isError: true }));
    assert(write2.isError, "Write existing file with ifMatch=null should fail");

    console.log("6. apply_patch");
    const patchStr = `*** Begin Patch\n*** Update File: src/other.ts\n@@\n-export const other = true;\n+export const other = false;\n*** End Patch`;
    const patch1 = await callTool("apply_patch", {
      workspaceId,
      patch: patchStr,
      ifMatch: { "src/other.ts": "sha256:0c6965a238463ceed4ca45d99772dc3c88308e970691ec051732e4d7094d28e0" }
    });
    assert(!patch1.isError, "Patch should succeed");

    console.log("All tests passed successfully.");
  } finally {
    console.log("Closing MCP client...");
    await transport.close();
    await rm(tarballPath, { force: true }).catch(() => {});
    await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
