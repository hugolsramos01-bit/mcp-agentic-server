import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResponse } from "./pi-tools.js";

const execFileAsync = promisify(execFile);
const CHECKPOINT_DIR = ".agentic-checkpoints";

function checkpointDir(cwd: string): string {
  const dir = join(cwd, CHECKPOINT_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Add to git exclude so checkpoints never appear as untracked files in git_status,
    // changed_files_summary, or show_changes — they are internal metadata, not project changes.
    const excludePath = join(cwd, ".git", "info", "exclude");
    try {
      const excludeContent = readFileSync(excludePath, "utf8");
      if (!excludeContent.includes(CHECKPOINT_DIR)) {
        appendFileSync(excludePath, `\n# Agentic MCP checkpoints\n${CHECKPOINT_DIR}/\n`);
      }
    } catch { /* git info/exclude not available — non-fatal */ }
  }
  return dir;
}

function listCheckpoints(cwd: string): { id: string; timestamp: string; description: string }[] {
  const dir = checkpointDir(cwd);
  const entries = readdirSync(dir, { withFileTypes: true });
  const checkpoints: { id: string; timestamp: string; description: string }[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const metaPath = join(dir, entry.name, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8"));
          checkpoints.push({
            id: entry.name,
            timestamp: meta.timestamp,
            description: meta.description,
          });
        } catch {
          checkpoints.push({ id: entry.name, timestamp: "unknown", description: "(metadata missing)" });
        }
      }
    }
  }

  return checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// --- checkpoint_save ---

export interface CheckpointSaveInput {
  description?: string;
}

export async function checkpointSaveTool(cwd: string, input: CheckpointSaveInput): Promise<ToolResponse> {
  const isGitRepo = existsSync(join(cwd, ".git"));
  if (!isGitRepo) {
    return {
      content: [{ type: "text", text: "Not a git repository. Checkpoints require a git repository." }],
      isError: true,
    };
  }

  const dir = checkpointDir(cwd);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cpDir = join(dir, `cp-${timestamp}`);
  mkdirSync(cpDir, { recursive: true });

  try {
    // Generate diff — if previous checkpoint exists, diff against its stored state
    // Otherwise diff against HEAD. This makes each checkpoint a delta.
    const checkpoints = listCheckpoints(cwd);
    let diff: string;
    if (checkpoints.length > 0) {
      // Reset to the previous checkpoint's state first, then diff
      // For simplicity, just diff against HEAD — the restore logic handles stacking
      const { stdout } = await execFileAsync("git", ["diff"], { cwd });
      diff = stdout;
    } else {
      const { stdout } = await execFileAsync("git", ["diff"], { cwd });
      diff = stdout;
    }
    
    // Also capture staged changes
    const { stdout: stagedDiff } = await execFileAsync("git", ["diff", "--cached"], { cwd });
    // Capture untracked files
    const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    // Save the exact changed tracked-file state as well. A diff alone cannot
    // reliably restore a checkpoint after later edits have changed its context.
    const { stdout: changedTracked } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd });
    const trackedFiles = changedTracked.trim() ? changedTracked.trim().split("\n").map((path) => ({
      path,
      existed: existsSync(join(cwd, path)),
    })) : [];
    if (trackedFiles.length) {
      const trackedDir = join(cpDir, "tracked");
      for (const entry of trackedFiles) {
        if (!entry.existed) continue;
        const source = join(cwd, entry.path);
        const target = join(trackedDir, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    }

    const combined = [
      diff ? `# UNSTAGED CHANGES\n${diff}` : "",
      stagedDiff ? `# STAGED CHANGES\n${stagedDiff}` : "",
      untracked ? `# UNTRACKED FILES\n${untracked}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (!combined.trim()) {
      // Allow saving a baseline checkpoint (clean workspace baseline)
      writeFileSync(join(cpDir, "patch.diff"), "# BASELINE — no changes\n", "utf8");
      const meta = {
        version: 2,
        timestamp: new Date().toISOString(),
        description: input.description || `Baseline ${timestamp}`,
        hasUntracked: false,
        isBaseline: true,
        parentId: checkpoints.length > 0 ? checkpoints[0].id : undefined,
      };
      writeFileSync(join(cpDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      return {
        content: [{ type: "text", text: JSON.stringify({
          id: `cp-${timestamp}`,
          description: meta.description,
          timestamp: meta.timestamp,
          message: "Baseline checkpoint created (clean workspace). You can restore to this state after making changes.",
        }, null, 2) }],
      };
    }

    writeFileSync(join(cpDir, "patch.diff"), combined, "utf8");

    // Save untracked file contents
    if (untracked.trim()) {
      const untrackedDir = join(cpDir, "untracked");
      mkdirSync(untrackedDir, { recursive: true });
      const files = untracked.trim().split("\n");
      for (const file of files) {
        const filePath = join(cwd, file);
        if (!existsSync(filePath)) continue;
        // Skip directories (git ls-files --others can list dirs)
        const stat = await import("node:fs").then(fs => fs.statSync(filePath));
        if (stat.isDirectory()) continue;
        
        // Compute parent dir correctly for files with and without path separators
        const lastSep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
        const parentDir = lastSep >= 0 ? file.substring(0, lastSep) : "";
        const targetDir = parentDir ? join(untrackedDir, parentDir) : untrackedDir;
        if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(untrackedDir, file), readFileSync(filePath));
      }
    }

    const meta = {
      version: 2,
      timestamp: new Date().toISOString(),
      description: input.description || `Checkpoint ${timestamp}`,
      hasUntracked: untracked.trim().length > 0,
      trackedFiles,
      parentId: checkpoints.length > 0 ? checkpoints[0].id : undefined,
    };
    writeFileSync(join(cpDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    
    // Update checkpoint index
    const index = checkpoints.map(c => ({ id: c.id, timestamp: c.timestamp, description: c.description }));
    index.unshift({ id: `cp-${timestamp}`, timestamp: meta.timestamp, description: meta.description });
    writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2), "utf8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: `cp-${timestamp}`,
              description: meta.description,
              timestamp: meta.timestamp,
              hasUntracked: meta.hasUntracked,
              message: "Checkpoint created successfully.",
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    rmSync(cpDir, { recursive: true, force: true });
    return {
      content: [{ type: "text", text: `Error creating checkpoint: ${error.message}` }],
      isError: true,
    };
  }
}

// --- checkpoint_list ---

export interface CheckpointListInput {}

export async function checkpointListTool(cwd: string): Promise<ToolResponse> {
  const dir = join(cwd, CHECKPOINT_DIR);
  if (!existsSync(dir)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ checkpoints: [] }, null, 2) }],
    };
  }

  const checkpoints = listCheckpoints(cwd);
  return {
    content: [{ type: "text", text: JSON.stringify({ checkpoints }, null, 2) }],
  };
}

// ─── checkpoint_restore ─────────────────────────────────────
// Uses git stash-based approach for reliable restoration.
// The checkpoint stores a diff; on restore we verify the working
// tree matches the expected pre-checkpoint state via git stash.

export interface CheckpointRestoreInput {
  id: string;
}

export async function checkpointRestoreTool(cwd: string, input: CheckpointRestoreInput): Promise<ToolResponse> {
  const dir = checkpointDir(cwd);
  const cpDir = join(dir, input.id);

  if (!existsSync(cpDir)) {
    return {
      content: [{ type: "text", text: `Checkpoint "${input.id}" not found.` }],
      isError: true,
    };
  }

  const patchPath = join(cpDir, "patch.diff");
  if (!existsSync(patchPath)) {
    return {
      content: [{ type: "text", text: `Checkpoint "${input.id}" has no patch data.` }],
      isError: true,
    };
  }

  // Load metadata to understand what was saved
  let meta: any = {};
  try {
    meta = JSON.parse(readFileSync(join(cpDir, "meta.json"), "utf8"));
  } catch {}

  try {
    // V2 uses file snapshots for modified tracked files, which is deterministic
    // even when a later edit means that a reverse patch would no longer apply.
    if (meta.version === 2 && Array.isArray(meta.trackedFiles)) {
      const warnings: string[] = [];
      await execFileAsync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], { cwd });
      const trackedDir = join(cpDir, "tracked");
      for (const entry of meta.trackedFiles as { path: string; existed: boolean }[]) {
        const target = join(cwd, entry.path);
        if (!entry.existed) {
          try { rmSync(target, { force: true }); } catch (error: any) { warnings.push(`Could not remove ${entry.path}: ${error.message}`); }
          continue;
        }
        const snapshot = join(trackedDir, entry.path);
        try {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(snapshot, target);
        } catch (error: any) { warnings.push(`Could not restore ${entry.path}: ${error.message}`); }
      }

      const untrackedDir = join(cpDir, "untracked");
      const savedUntracked = new Set<string>();
      if (existsSync(untrackedDir)) {
        const walk = (dir: string, prefix = "") => readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
          const rel = prefix ? join(prefix, entry.name) : entry.name;
          if (entry.isDirectory()) walk(join(dir, entry.name), rel);
          else savedUntracked.add(rel.replace(/\\/g, "/"));
        });
        walk(untrackedDir);
      }
      const { stdout: currentUntracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
      for (const raw of currentUntracked.split("\n")) {
        const rel = raw.trim();
        if (rel && !savedUntracked.has(rel.replace(/\\/g, "/"))) {
          try { rmSync(join(cwd, rel), { recursive: true, force: true }); } catch (error: any) { warnings.push(`Could not remove ${rel}: ${error.message}`); }
        }
      }
      if (existsSync(untrackedDir)) {
        const restore = (dir: string, prefix = "") => readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
          const rel = prefix ? join(prefix, entry.name) : entry.name;
          if (entry.isDirectory()) restore(join(dir, entry.name), rel);
          else { const target = join(cwd, rel); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(dir, entry.name), target); }
        });
        restore(untrackedDir);
      }
      return { content: [{ type: "text", text: JSON.stringify({ id: input.id, status: warnings.length ? "partial" : "success", message: warnings.length ? "Checkpoint partially restored." : "Checkpoint restored.", warnings, restoredTrackedFiles: meta.trackedFiles.length, restoredUntrackedFiles: savedUntracked.size }, null, 2) }], isError: warnings.length > 0 };
    }
    // Handle baseline restore (clean workspace snapshot)
    if (meta.isBaseline) {
      // 1. Stash any current tracked changes to restore to clean state
      const { stdout: hasChanges } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
      if (hasChanges.trim()) {
        await execFileAsync("git", ["stash"], { cwd });
      }
      // 2. Remove untracked files that were created after baseline
      const { stdout: untrackedFiles } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
      if (untrackedFiles.trim()) {
        const files = untrackedFiles.trim().split("\n");
        for (const f of files) {
          try { rmSync(join(cwd, f.trim()), { recursive: true, force: true }); } catch {}
        }
      }
      // 3. Verify the restore was complete
      const { stdout: verifyStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
      const isClean = !verifyStatus.trim();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: input.id,
            message: isClean ? "Baseline restored. Working tree is clean." : "Baseline partially restored. Remaining: " + verifyStatus.trim().split("\n").slice(0, 5).join("; "),
            clean: isClean,
          }, null, 2),
        }],
      };
    }

    // Step 1: Capture the exact file state at checkpoint time
    const patchContent = readFileSync(patchPath, "utf8");
    const untrackedDir = join(cpDir, "untracked");
    const hasSavedUntracked = existsSync(untrackedDir);

    // Step 2: Read checkpoint manifest — what untracked files existed at checkpoint time
    const checkpointUntrackedFiles = new Set<string>();
    if (hasSavedUntracked) {
      // Walk the untracked directory to know which files were saved
      function walkUntracked(dirPath: string, prefix: string) {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name);
          const relPath = prefix ? join(prefix, entry.name) : entry.name;
          if (entry.isDirectory()) {
            walkUntracked(fullPath, relPath);
          } else {
            checkpointUntrackedFiles.add(relPath.replace(/\\/g, "/"));
          }
        }
      }
      walkUntracked(untrackedDir, "");
    }

    // Step 3: Remove NEW untracked files that didn't exist at checkpoint time
    // (these were created between checkpoint and restore, so they must go)
    const { stdout: currentUntracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    if (currentUntracked.trim()) {
      for (const rawFile of currentUntracked.trim().split("\n")) {
        const file = rawFile.trim();
        if (!file) continue;
        // Only remove if it wasn't in the checkpoint
        if (checkpointUntrackedFiles.has(file.replace(/\\/g, "/"))) continue;
        const fullPath = join(cwd, file);
        try {
          const stat = await import("node:fs").then(fs => fs.statSync(fullPath));
          if (stat.isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
          } else {
            rmSync(fullPath, { force: true });
          }
        } catch {}
      }
    }

    // Step 4: Restore untracked files from checkpoint (overwrite with saved versions)
    if (hasSavedUntracked) {
      function restoreUntracked(dirPath: string, prefix: string) {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name);
          const relPath = prefix ? join(prefix, entry.name) : entry.name;
          if (entry.isDirectory()) {
            restoreUntracked(fullPath, relPath);
          } else {
            const targetPath = join(cwd, relPath);
            const lastSep = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
            const targetParent = lastSep >= 0 ? join(cwd, relPath.substring(0, lastSep)) : cwd;
            if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });
            copyFileSync(fullPath, targetPath);
          }
        }
      }
      restoreUntracked(untrackedDir, "");
    }

    // Step 5: Apply tracked file reverse patch — git apply -R
    // But first, verify the patch is well-formed by checking if it has any tracked changes
    if (patchContent.includes("---") && !patchContent.startsWith("# BASELINE")) {
      try {
        await execFileAsync("git", ["apply", "-R", patchPath], { cwd });
      } catch (applyError: any) {
        // Fallback: try with --reject for partial application
        try {
          await execFileAsync("git", ["apply", "-R", "--reject", patchPath], { cwd });
        } catch {
          return {
            content: [{
              type: "text",
              text: `Checkpoint restore conflict: working tree has diverged from checkpoint state.\n` +
                `Error: ${applyError.message}\n\n` +
                `The checkpoint diff could not be cleanly reversed. Untracked files were restored, but tracked file changes could not be reverted automatically.\n\n` +
                `Try manually resolving with: git checkout -- <files>`,
            }],
            isError: true,
          };
        }
      }
    }

    // Step 6: Verify — git status should be clean (or match checkpoint)
    const { stdout: verifyStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    const isClean = !verifyStatus.trim();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: input.id,
              message: isClean ? "Checkpoint restored successfully. Working tree is clean." : "Checkpoint partially restored. Remaining: " + verifyStatus.trim().split("\n").slice(0, 3).join("; "),
              clean: isClean,
              untrackedRestored: hasSavedUntracked,
              untrackedFilesCount: checkpointUntrackedFiles.size,
              trackedRestored: patchContent.includes("---") && !patchContent.startsWith("# BASELINE"),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error restoring checkpoint: ${error.message}` }],
      isError: true,
    };
  }
}

// --- checkpoint_delete ---

export interface CheckpointDeleteInput {
  id: string;
}

export async function checkpointDeleteTool(cwd: string, input: CheckpointDeleteInput): Promise<ToolResponse> {
  const dir = checkpointDir(cwd);
  const cpDir = join(dir, input.id);

  if (!existsSync(cpDir)) {
    return {
      content: [{ type: "text", text: `Checkpoint "${input.id}" not found.` }],
      isError: true,
    };
  }

  try {
    rmSync(cpDir, { recursive: true, force: true });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: input.id, message: "Checkpoint deleted." }, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error deleting checkpoint: ${error.message}` }],
      isError: true,
    };
  }
}

