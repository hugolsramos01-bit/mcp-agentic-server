import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { editFileTool, writeFileTool } from "../pi-tools.js";
import { applyAtomicMutation, computeFileHash } from "./tool-utils.js";

async function createWorkspace(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agentic-atomic-dotfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryArtifacts(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .map(String)
    .filter((entry) => basename(entry).startsWith(".agentic-tmp-"));
}

async function atomicWrite(root: string, path: string, content: string) {
  return applyAtomicMutation({
    cwd: root,
    root,
    targetPath: path,
    ifMatch: null,
    requireIfMatch: "off",
    mutate: (temporaryPath) =>
      writeFileTool(
        { path: temporaryPath, content },
        { cwd: root, root },
      ),
  });
}

test("atomic write supports allowed dotfiles without target-derived temporaries", async (t) => {
  const root = await createWorkspace(t);
  const dotfiles = [
    ".gitignore",
    ".prettierrc",
    ".eslintrc",
    ".editorconfig",
    ".env.example",
    ".branch-test-do-not-keep",
  ];

  for (const path of dotfiles) {
    const result = await atomicWrite(root, path, `${path}=ok\n`);
    assert.equal(result.isError, undefined, `write should succeed for ${path}`);
    assert.equal(await readFile(join(root, path), "utf8"), `${path}=ok\n`);
  }

  assert.deepEqual(await temporaryArtifacts(root), []);
});

test("atomic write supports a dotfile inside a newly created directory", async (t) => {
  const root = await createWorkspace(t);
  const result = await atomicWrite(root, "config/.gitignore", "generated\n");

  assert.equal(result.isError, undefined);
  assert.equal(
    await readFile(join(root, "config", ".gitignore"), "utf8"),
    "generated\n",
  );
  assert.deepEqual(await temporaryArtifacts(root), []);
});

test("atomic edit updates an existing dotfile", async (t) => {
  const root = await createWorkspace(t);
  const target = join(root, ".gitignore");
  await writeFile(target, "node_modules\ndist\n", "utf8");

  const result = await applyAtomicMutation({
    cwd: root,
    root,
    targetPath: ".gitignore",
    ifMatch: computeFileHash(target),
    requireIfMatch: "off",
    mutate: (temporaryPath) =>
      editFileTool(
        {
          path: temporaryPath,
          edits: [{ oldText: "dist\n", newText: "dist\ncoverage\n" }],
        },
        { cwd: root, root },
      ),
  });

  assert.equal(result.isError, undefined);
  assert.equal(await readFile(target, "utf8"), "node_modules\ndist\ncoverage\n");
  assert.deepEqual(await temporaryArtifacts(root), []);
});

test("rename failure preserves the original and removes the temporary file", async (t) => {
  const root = await createWorkspace(t);
  const target = join(root, ".prettierrc");
  await writeFile(target, "old\n", "utf8");

  const result = await applyAtomicMutation({
    cwd: root,
    root,
    targetPath: ".prettierrc",
    ifMatch: computeFileHash(target),
    requireIfMatch: "off",
    mutate: async (temporaryPath) => {
      await writeFile(temporaryPath, "new\n", "utf8");
      return { content: [{ type: "text", text: "updated" }] };
    },
    renameFile: () => {
      throw new Error("simulated rename failure");
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /simulated rename failure/);
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await temporaryArtifacts(root), []);
});

test("mutation failure removes the reserved sibling", async (t) => {
  const root = await createWorkspace(t);
  const result = await applyAtomicMutation({
    cwd: root,
    root,
    targetPath: ".gitignore",
    ifMatch: null,
    requireIfMatch: "off",
    mutate: async (temporaryPath) => {
      await writeFile(temporaryPath, "partial\n", "utf8");
      return {
        isError: true,
        content: [{ type: "text", text: "simulated mutation failure" }],
      };
    },
  });

  assert.equal(result.isError, true);
  await assert.rejects(readFile(join(root, ".gitignore"), "utf8"), /ENOENT/);
  assert.deepEqual(await temporaryArtifacts(root), []);
});

test("secret dotfiles remain blocked by the existing security policy", async (t) => {
  const root = await createWorkspace(t);

  for (const path of [".env", ".npmrc"]) {
    await assert.rejects(
      atomicWrite(root, path, "secret=value\n"),
      /Security Policy Violation/,
    );
  }

  assert.deepEqual(await temporaryArtifacts(root), []);
});
