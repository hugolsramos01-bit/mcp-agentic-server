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

  const suppliedTarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
  let tarballPath;
  let shouldDeleteTarball = false;

  if (suppliedTarball) {
    await stat(suppliedTarball);
    tarballPath = suppliedTarball;
    console.log(`Using supplied tarball: ${tarballPath}`);
  } else {
    console.log("Packing project...");
    const { stdout: packOut } = await exec(`npm pack`, { cwd: ROOT });
    const generatedName = packOut.trim().split("\n").pop().trim();
    tarballPath = join(ROOT, generatedName);
    shouldDeleteTarball = true;
  }

  const tarballLabel = tarballPath.split(/[\\/]/).pop();

  const installDir = join(TEMP_DIR, "install-env");
  await mkdir(installDir);
  await writeFile(join(installDir, "package.json"), JSON.stringify({ name: "test-env" }));

  console.log(`Installing ${tarballLabel}...`);
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
    
    const tc1Text = JSON.stringify(tc1);
    assert(!tc1Text.includes("excluded/secret.ts"), "Excluded file should not be present");
    assert(tc1Text.includes("tests/auth.test.ts"), "Tests should be in context since they depend on focused files");
    
    const tc1Data = tc1.structuredContent?.data?.envelope || tc1.structuredContent?.envelope || tc1.structuredContent?.result || tc1.structuredContent?.data || tc1.structuredContent;
    assert.equal(tc1Data.riskProfile.version, 1, "riskProfile.version must be 1");
    assert.ok(["low", "medium", "high", "critical"].includes(tc1Data.riskProfile.level), "riskProfile.level must be valid");
    assert.equal(tc1Data.riskProfile.basis, "pre_budget", "riskProfile.basis must be pre_budget");

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
    assert.equal(
      rmData.skipped[0].code,
      "file_not_found",
      "Reason should be file_not_found"
    );
    const authHash = rmData.files[0].contentHash;

    const rm2 = await callTool("read_many", {
      workspaceId,
      paths: ["src/missing1.ts", "src/missing2.ts"]
    }).catch(e => e);
    console.log("rm2:", rm2);
    
    assert.equal(
      rm2.structuredContent?.status,
      "error",
      "Structured status should be error"
    );
    const rm2Skipped = rm2.structuredContent?.data?.skipped ?? [];
    assert.equal(rm2Skipped.length, 2, "Should have 2 skipped files");
    assert.ok(
      rm2Skipped.every(
        (item) => item.code === "file_not_found" || item.code === "path_resolution_failed"
      ),
      "Skipped items should be file_not_found or path_resolution_failed"
    );

    console.log("3.5. read_many: Skeletal Compression");
    const rmSkeletal = await callTool("read_many", {
      workspaceId,
      paths: ["src/auth.ts"],
      compressionLevel: "skeletal"
    });
    const skeletalContent = rmSkeletal.structuredContent?.data?.files[0]?.content;
    assert(skeletalContent, "Should return content for skeletal compression");
    assert(!skeletalContent.includes(fixtureRepo), "Skeletal content should not leak absolute path");
    assert(skeletalContent.includes("src/auth.ts"), "Skeletal content should include relative path");

    console.log("3.6. read_many: Budget-only skips (success)");
    const rmBudget = await callTool("read_many", {
      workspaceId,
      paths: ["src/auth.ts"],
      maxTokens: 2
    });
    assert.equal(
      rmBudget.structuredContent?.status,
      "success",
      "Budget test status should be success"
    );
    assert.equal(
      rmBudget.structuredContent?.data?.files?.length,
      0,
      "Budget test files length should be 0"
    );
    assert.equal(
      rmBudget.structuredContent?.data?.warning,
      "budget_exhausted",
      "Budget test should return budget_exhausted warning"
    );
    assert.ok(
      rmBudget.structuredContent?.data?.skipped?.every((item) => item.code === "budget_exceeded"),
      "All skipped items should be budget_exceeded"
    );

    console.log("3.7. read_many: Mixed failure (error)");
    const rmMixed = await callTool("read_many", {
      workspaceId,
      paths: ["src/auth.ts", "src/missing.ts"],
      maxTokens: 2
    }).catch(e => e);
    assert.equal(
      rmMixed.structuredContent?.status,
      "error",
      "Mixed test status should be error"
    );
    assert.ok(
      rmMixed.structuredContent?.data?.skipped?.some((item) => item.code !== "budget_exceeded"),
      "At least one skipped item should not be budget_exceeded"
    );

    console.log("4. edit: Success and ifMatch");
    const edit1 = await callTool("edit", {
      workspaceId,
      path: "src/auth.ts",
      edits: [{ oldText: "export const auth = true;", newText: "export const auth = false;" }],
      ifMatch: authHash
    });
    
    assert(!edit1.isError, "Edit should succeed");
    
    const editReceipt = edit1.structuredContent?.data?.mutationReceipt?.files?.[0] || edit1.structuredContent?.mutationReceipt?.files?.[0];
    console.log("edit1.structuredContent:", JSON.stringify(edit1.structuredContent, null, 2));
    if (!editReceipt) {
      throw new Error("editReceipt is missing");
    }
    assert.equal(editReceipt.beforeHash, authHash, "edit beforeHash should match authHash");
    assert.ok(editReceipt.afterHash?.startsWith("sha256:"), "edit afterHash should be present");
    assert.notEqual(editReceipt.beforeHash, editReceipt.afterHash, "edit beforeHash and afterHash should differ");
    
    const edit2 = await callTool("edit", {
      workspaceId,
      path: "src/auth.ts",
      edits: [{ oldText: "export const auth = false;", newText: "export const auth = true;" }],
      ifMatch: authHash // old hash
    }).catch(e => {
       return { isError: true, message: e.message, structuredContent: e.data };
    });
    assert(edit2.isError || edit2.code, "Edit should fail with file_version_conflict");
    const edit2Content = edit2.structuredContent?.data || edit2.structuredContent;
    assert(edit2Content?.mutationApplied === false, "mutationApplied should be false on conflict");

    console.log("5. write: file_version_conflict");
    const write1 = await callTool("write", {
      workspaceId,
      path: "src/new.ts",
      content: "export const n = 1;",
      ifMatch: null
    });
    assert(!write1.isError, "Write new file should succeed");
    const writeReceipt = write1.structuredContent?.data?.mutationReceipt?.files?.[0] || write1.structuredContent?.mutationReceipt?.files?.[0];
    assert.equal(writeReceipt.beforeHash, null, "write add beforeHash should be null");
    assert.ok(writeReceipt.afterHash?.startsWith("sha256:"), "write add afterHash should be present");

    const write2 = await callTool("write", {
      workspaceId,
      path: "src/new.ts",
      content: "export const n = 2;",
      ifMatch: null
    }).catch(e => ({ isError: true }));
    assert(write2.isError, "Write existing file with ifMatch=null should fail");

    const write3 = await callTool("write", {
      workspaceId,
      path: "src/new.ts",
      content: "export const n = 3;",
      ifMatch: writeReceipt.afterHash
    });
    assert(!write3.isError, "Write existing file with correct ifMatch should succeed");
    const write3Receipt = write3.structuredContent?.data?.mutationReceipt?.files?.[0] || write3.structuredContent?.mutationReceipt?.files?.[0];
    assert.equal(write3Receipt.beforeHash, writeReceipt.afterHash, "write update beforeHash should match previous afterHash");
    assert.ok(write3Receipt.afterHash?.startsWith("sha256:"), "write update afterHash should be present");

    console.log("6. apply_patch");
    const patchStr = `*** Begin Patch\n*** Update File: src/other.ts\n@@\n-export const other = true;\n+export const other = false;\n*** End Patch`;
    const patch1 = await callTool("apply_patch", {
      workspaceId,
      patch: patchStr,
      ifMatch: { "src/other.ts": "sha256:0c6965a238463ceed4ca45d99772dc3c88308e970691ec051732e4d7094d28e0" }
    });
    assert(!patch1.isError, "Patch should succeed");
    const patchReceipt = patch1.structuredContent?.data?.mutationReceipt?.files?.[0] || patch1.structuredContent?.mutationReceipt?.files?.[0];
    assert.equal(patchReceipt.beforeHash, "sha256:0c6965a238463ceed4ca45d99772dc3c88308e970691ec051732e4d7094d28e0", "apply_patch update beforeHash should match");
    assert.ok(patchReceipt.afterHash?.startsWith("sha256:"), "apply_patch update afterHash should be present");

    const addPatchStr = `*** Begin Patch\n*** Add File: src/added.ts\n+export const added = true;\n*** End Patch`;
    const patch2 = await callTool("apply_patch", {
      workspaceId,
      patch: addPatchStr,
      ifMatch: { "src/added.ts": null }
    });
    assert(!patch2.isError, "Patch add should succeed");
    const patch2Receipt = patch2.structuredContent?.data?.mutationReceipt?.files?.[0] || patch2.structuredContent?.mutationReceipt?.files?.[0];
    assert.equal(patch2Receipt.beforeHash, null, "apply_patch add beforeHash should be null");
    assert.ok(patch2Receipt.afterHash?.startsWith("sha256:"), "apply_patch add afterHash should be present");

    const deletePatchStr = `*** Begin Patch\n*** Delete File: src/added.ts\n*** End Patch`;
    const patch3 = await callTool("apply_patch", {
      workspaceId,
      patch: deletePatchStr,
      ifMatch: { "src/added.ts": patch2Receipt.afterHash }
    });
    assert(!patch3.isError, "Patch delete should succeed");
    const patch3Receipt = patch3.structuredContent?.data?.mutationReceipt?.files?.[0] || patch3.structuredContent?.mutationReceipt?.files?.[0];
    assert.equal(patch3Receipt.beforeHash, patch2Receipt.afterHash, "apply_patch delete beforeHash should match previous");
    assert.equal(patch3Receipt.afterHash, null, "apply_patch delete afterHash should be null");

    console.log("All tests passed successfully.");
  } finally {
    console.log("Closing MCP client...");
    await transport.close();
    if (shouldDeleteTarball) {
      await rm(tarballPath, { force: true }).catch(() => {});
    }
    await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
