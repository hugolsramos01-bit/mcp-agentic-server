import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkpointListTool, checkpointRestoreTool, checkpointSaveTool } from "./checkpoint-tools.js";

const execFileAsync = promisify(execFile);
const repository = await mkdtemp(join(tmpdir(), "agentic-checkpoint-worktree-test-"));
const worktree = join(repository, "linked-worktree");

try {
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "agentic@example.com"]);
  await git(repository, ["config", "user.name", "Agentic MCP Test"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  await git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

  const fixturePath = join(worktree, "src", "fixture.ts");
  const expected = "export const fixture = 'checkpointed';\n";
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(fixturePath, expected);

  const saved = await checkpointSaveTool(worktree, { description: "worktree fixture" });
  assert.equal(Boolean(saved.isError), false, toolText(saved));
  const checkpoint = JSON.parse(toolText(saved));
  assert.match(checkpoint.id, /^cp-/);

  const checkpointDirectory = (await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "agentic-checkpoints"])).stdout.trim();
  assert.equal(checkpointDirectory.startsWith(worktree), false, "checkpoint data must not be inside the worktree");

  await writeFile(fixturePath, "export const fixture = ;\n");
  const restored = await checkpointRestoreTool(worktree, { id: checkpoint.id });
  assert.equal(Boolean(restored.isError), false, toolText(restored));
  const restoreResult = JSON.parse(toolText(restored));
  assert.equal(restoreResult.status, "success");
  assert.equal(await readFile(fixturePath, "utf8"), expected);

  const listed = await checkpointListTool(worktree);
  assert.equal(JSON.parse(toolText(listed)).checkpoints.some((entry: { id: string }) => entry.id === checkpoint.id), true);
} finally {
  await git(repository, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
  await rm(repository, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

function toolText(response: { content: Array<{ type: string }> }): string {
  const first = response.content[0];
  assert.ok(first && first.type === "text");
  return (first as { type: "text"; text: string }).text;
}
