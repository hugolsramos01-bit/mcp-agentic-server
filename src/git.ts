import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head" | "ancestor_git_root";
  message?: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

/** Git tools operate only on a repository rooted at the opened workspace.
 * A directory inside an unrelated parent repository must not silently expose
 * sibling projects through Git output. */
export async function getWorkspaceGitEligibility(cwd: string): Promise<GitEligibility> {
  const eligibility = await getGitEligibility(cwd);
  if (!eligibility.ok || !eligibility.gitRoot) return eligibility;
  if (samePath(cwd, eligibility.gitRoot)) return eligibility;

  return {
    ok: false,
    gitRoot: eligibility.gitRoot,
    reason: "ancestor_git_root",
    message: "workspace is inside a parent Git repository, but that repository is outside the opened workspace. Open the repository root or create a worktree with allowParentGitRoot: true.",
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const absolute = resolve(value);
    const canonical = (() => { try { return realpathSync.native(absolute); } catch { return absolute; } })();
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return normalize(left) === normalize(right);
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
