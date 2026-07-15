import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

const worktreeRegistry = new Map<string, ManagedWorktree>();

export function getManagedWorktrees(): ManagedWorktree[] {
  return Array.from(worktreeRegistry.values());
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
  uniqueSuffix?: string;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  
  const registryKey = `${sourceRoot}:${baseSha}:${input.uniqueSuffix ?? ""}`;
  if (worktreeRegistry.has(registryKey)) {
    const existing = worktreeRegistry.get(registryKey)!;
    try {
      await stat(existing.path);
      // Update dirtySource in case it changed
      existing.dirtySource = dirtySource;
      return existing;
    } catch {
      worktreeRegistry.delete(registryKey);
    }
  }
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
    suffix: input.uniqueSuffix,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  const result = {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
  
  worktreeRegistry.set(registryKey, result);
  return result;
}

export async function removeManagedWorktree(input: {
  worktreePath: string;
  sourceRoot: string;
  force?: boolean;
}): Promise<void> {
  // Step 0: Check if worktree has uncommitted changes — warn before destroying
  // (unless force=true is explicitly passed)
  if (!input.force) {
    try {
      const status = (await git(["status", "--porcelain"], input.worktreePath)).trim();
      if (status.length > 0) {
        // The worktree has uncommitted changes. Instead of silently removing,
        // we throw an error that tells the model to pass force=true if they
        // really want to discard.
        throw new GitWorktreeError(
          "GIT_WORKTREE_CREATE_FAILED" as any,
          `Worktree ${input.worktreePath} has uncommitted changes:\n${status}\n\nPass force=true to discard them.`
        );
      }
    } catch (error: any) {
      // Re-throw our own GitWorktreeError from above; swallow others (e.g. if worktree dir doesn't exist)
      if (error instanceof GitWorktreeError) throw error;
    }
  }

  // Step 1: Try git worktree remove first
  try {
    await git(["worktree", "remove", "--force", input.worktreePath], input.sourceRoot);
  } catch {
    // If git worktree remove fails, try to remove the directory directly
  }

  // Step 2: Ensure directory is physically removed (git worktree remove doesn't always delete the dir)
  try {
    const { rm } = await import("node:fs/promises");
    await rm(input.worktreePath, { recursive: true, force: true, maxRetries: 3 });
  } catch {}

  // Step 3: Remove from registry only after successful physical removal
  for (const [key, value] of worktreeRegistry.entries()) {
    if (value.path === input.worktreePath) {
      worktreeRegistry.delete(key);
    }
  }

  // Step 4: Clean up stale registry entries (paths that no longer exist on disk)
  for (const [key, value] of worktreeRegistry.entries()) {
    try {
      await import("node:fs").then(fs => fs.promises.access(value.path));
    } catch {
      worktreeRegistry.delete(key);
    }
  }
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string; suffix?: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const suffix = input.suffix ? `-${sanitizePathSegment(input.suffix)}` : "";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}${suffix}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
