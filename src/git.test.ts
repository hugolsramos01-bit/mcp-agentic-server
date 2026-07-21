import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitTool } from "./assistant-tools.js";
import { getWorkspaceGitEligibility } from "./git.js";

const execFileAsync = promisify(execFile);
const repository = await mkdtemp(join(tmpdir(), "agentic-git-boundary-"));
const child = join(repository, "atlas");

try {
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "agentic@example.com"]);
  await git(repository, ["config", "user.name", "Agentic MCP Test"]);
  await writeFile(join(repository, "README.md"), "parent\n");
  await mkdir(child);
  await writeFile(join(child, "app.js"), "export default 1;\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  await writeFile(join(repository, "sibling.txt"), "outside the opened workspace\n");

  const childEligibility = await getWorkspaceGitEligibility(child);
  assert.equal(childEligibility.ok, false);
  assert.equal(childEligibility.reason, "ancestor_git_root");

  const blocked = await gitTool("status", {}, child);
  assert.equal(blocked.isError, true);
  assert.match((blocked.content[0] as { text: string }).text, /outside the opened workspace/i);

  const rootEligibility = await getWorkspaceGitEligibility(repository);
  assert.equal(rootEligibility.ok, true);
} finally {
  await rm(repository, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}
