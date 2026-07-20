import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "agentic-review-checkpoints-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "agentic@example.com"]);
  await git(root, ["config", "user.name", "Agentic MCP Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });

  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes/);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(firstReview.summary.files, 2);
  assert.equal(firstReview.summary.additions, 2);
  assert.equal(firstReview.summary.removals, 0);
  assert.equal(firstReview.files.some((file) => file.path === "README.md"), true);
  assert.equal(firstReview.files.some((file) => file.path === "new.txt"), true);
  assert.equal(firstReview.files.find((file) => file.path === "README.md")?.type, "change");
  assert.equal(firstReview.files.find((file) => file.path === "new.txt")?.type, "new");
  assert.match(firstReview.patch, /world/);

  const stillUnreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(stillUnreviewed.summary.files, 2);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

const worktreeRepository = await mkdtemp(join(tmpdir(), "agentic-review-worktree-test-"));
const worktree = join(worktreeRepository, "linked-worktree");

try {
  await git(worktreeRepository, ["init"]);
  await git(worktreeRepository, ["config", "user.email", "agentic@example.com"]);
  await git(worktreeRepository, ["config", "user.name", "Agentic MCP Test"]);
  await writeFile(join(worktreeRepository, "README.md"), "hello\n");
  await git(worktreeRepository, ["add", "README.md"]);
  await git(worktreeRepository, ["commit", "-m", "Initial commit"]);
  await git(worktreeRepository, ["worktree", "add", "--detach", worktree, "HEAD"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review_worktree", root: worktree });
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src", "tournament-evaluation.ts"), "export const evaluate = () => 'ready';\n");

  const review = await manager.reviewChanges({
    workspaceId: "ws_review_worktree",
    root: worktree,
    markReviewed: false,
  });
  assert.equal(review.files.some((file) => file.path === "src/tournament-evaluation.ts" && file.type === "new"), true);
  assert.match(review.patch, /tournament-evaluation/);
  assert.match(review.patch, /evaluate/);
} finally {
  await git(worktreeRepository, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
  await rm(worktreeRepository, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}


