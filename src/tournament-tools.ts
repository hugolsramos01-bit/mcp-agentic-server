import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree, removeManagedWorktree, type ManagedWorktree } from "./git-worktrees.js";
import type { ToolResponse } from "./pi-tools.js";
import { assertCommandAllowed } from "./security/command-executor.js";
import { collectPackageScriptCommands } from "./security/script-resolver.js";

const execFileAsync = promisify(execFile);

interface TournamentEntry {
  id: string;
  strategy: string;
  worktree: ManagedWorktree;
  workspaceId?: string;
  verdict?: TournamentVerdict;
}

interface TournamentVerdict {
  passed: boolean;
  details: string;
  durationMs: number;
}

export const activeTournaments = new Map<string, TournamentEntry[]>();

// --- tournament_spawn ---

export interface TournamentSpawnInput {
  workspaceRoot: string;
  strategies: string[];
  config: ServerConfig;
  /**
   * When true, dependencies are auto-installed in each worktree after creation
   * (using pnpm install, npm install, or yarn install based on lockfile).
   * Default: false (manual via worktree_install_deps).
   */
  installDependencies?: boolean;
  /**
   * Optional callback to register a worktree path as a valid workspace.
   * When provided, each spawned worktree is registered and a real workspaceId
   * is returned instead of a synthetic one. This enables worktree_install_deps
   * and other tools to work immediately with the returned IDs.
   */
  registerWorktree?: (worktreePath: string, sourceRoot: string) => Promise<{ workspaceId: string }>;
}

export async function tournamentSpawnTool(input: TournamentSpawnInput): Promise<ToolResponse> {
  const { workspaceRoot, strategies, config } = input;

  if (strategies.length < 2) {
    return {
      content: [{ type: "text", text: "tournament_spawn requires at least 2 strategies." }],
      isError: true,
    };
  }

  if (strategies.length > 5) {
    return {
      content: [{ type: "text", text: "Maximum 5 strategies per tournament." }],
      isError: true,
    };
  }

  const tournamentId = `tournament-${Date.now()}`;
  const entries: TournamentEntry[] = [];

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const id = `${tournamentId}-s${i + 1}`;

    try {
      const worktree = await createManagedWorktree({
        sourcePath: workspaceRoot,
        config,
        uniqueSuffix: `s${i + 1}`,
      });

      // Register the worktree as a real workspace if callback provided
      let workspaceId: string | undefined;
      if (input.registerWorktree) {
        const reg = await input.registerWorktree(worktree.path, worktree.sourceRoot);
        workspaceId = reg.workspaceId;
      }

      // Auto-install dependencies if requested
      if (input.installDependencies) {
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        let cmd = "npm";
        const args = ["install", "--ignore-scripts"];
        if (existsSync(join(worktree.path, "pnpm-lock.yaml"))) {
          cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
        } else if (existsSync(join(worktree.path, "yarn.lock"))) {
          cmd = process.platform === "win32" ? "yarn.cmd" : "yarn";
        }
        try {
          const { assertCommandAllowed } = await import("./security/command-executor.js");
          await assertCommandAllowed({
            command: `${cmd} ${args.join(" ")}`,
            workspaceRoot: worktree.path,
            workingDirectory: worktree.path,
            source: "dependency-install",
          });
          await execFileAsync(cmd, args, { cwd: worktree.path, timeout: 120_000, shell: false });
        } catch {
          // Non-fatal - worktree_install_deps can be called manually
        }
      }

      entries.push({ id, strategy, worktree, workspaceId });
    } catch (error: any) {
      // Clean up any already-created worktrees on failure
      for (const entry of entries) {
        try {
          await removeManagedWorktree({
            worktreePath: entry.worktree.path,
            sourceRoot: entry.worktree.sourceRoot,
          });
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Failed to spawn worktree for strategy "${strategy}": ${error.message}`,
                tournamentId,
                spawned: i,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  }

  activeTournaments.set(tournamentId, entries);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tournamentId,
            entries: entries.map((e) => ({
              id: e.id,
              strategy: e.strategy,
              workspaceId: e.workspaceId ?? `tournament-${e.id}`,
              worktreePath: e.worktree.path,
            })),
            instruction: "Each entry includes a real workspaceId. Use it directly with worktree_install_deps and other tools — no need to call open_workspace first.",
            instructions:
              "Spawned N worktrees (one per strategy). Each entry has a real workspaceId that works with all tools (worktree_install_deps, run_package_script, etc.). Implement each strategy, then call tournament_judge to compare results, and tournament_cleanup to tear down.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// --- tournament_judge ---

export interface TournamentJudgeInput {
  tournamentId: string;
  verificationScripts?: string[];
}

export async function tournamentJudgeTool(input: TournamentJudgeInput): Promise<ToolResponse> {
  const entries = activeTournaments.get(input.tournamentId);
  if (!entries) {
    return {
      content: [{ type: "text", text: `Tournament "${input.tournamentId}" not found.` }],
      isError: true,
    };
  }

  // Default verification: typecheck then build (script names only, not shell strings)
  const scripts =
    input.verificationScripts && input.verificationScripts.length > 0
      ? input.verificationScripts
      : ["typecheck", "build"];

  const results: any[] = [];

  for (const entry of entries) {
    const cwd = entry.worktree.path;
    const verdicts: TournamentVerdict[] = [];

    // Check if dependencies are required for the verification script
    // Only require node_modules when the script actually uses project dependencies:
    // - npm/yarn/pnpm run (package scripts)
    // - npx (local bin)
    // - tsx, node with local modules
    const hasNodeModules = existsSync(join(cwd, "node_modules"));
    const hasPkgJson = existsSync(join(cwd, "package.json"));
    const needsDeps = scripts.length > 0; // Assume scripts require node_modules

    if (hasPkgJson && !hasNodeModules && needsDeps) {
      verdicts.push({
        passed: false,
        details: `Dependencies not installed (missing node_modules/). Run worktree_install_deps with workspaceId "${entry.workspaceId ?? '(use open_workspace to get workspaceId)'}" first to hydrate dependencies.`,
        durationMs: 0,
      });
      results.push({
        id: entry.id,
        strategy: entry.strategy,
        worktreePath: entry.worktree.path,
        workspaceId: entry.workspaceId,
        allPassed: false,
        verdicts,
        diagnostic: "node_modules missing — install dependencies first",
      });
      continue;
    }

    // Fail-closed: require a readable package.json to identify scripts and their package manager
    let pkg: Record<string, any>;
    try {
      pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    } catch (e) {
      throw new Error(
        `Cannot read or parse package.json in ${cwd}. Verification refused to proceed (fail-closed).`,
      );
    }

    // Detect the package manager from lockfiles
    const packageManager = existsSync(join(cwd, "yarn.lock"))
      ? "yarn"
      : existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : "npm";
    const packageManagerCmd =
      packageManager + (process.platform === "win32" ? ".cmd" : "");

    for (const scriptName of scripts) {
      const start = performance.now();
      try {
        // Fail-closed: refuse unknown script names
        if (!pkg.scripts || !pkg.scripts[scriptName]) {
          throw new Error(
            `Script "${scriptName}" not found in package.json. Verification refused (fail-closed).`,
          );
        }

        // Fail-closed: let cycle / depth errors propagate — do NOT catch them
        const commandsToValidate = collectPackageScriptCommands({
          packageJson: pkg,
          scriptName,
          maxDepth: 10,
        });

        for (const cmd of commandsToValidate) {
          await assertCommandAllowed({
            command: cmd,
            workspaceRoot: cwd,
            workingDirectory: cwd,
            source: "tournament",
          });
        }

        // shell: false — invoke npm/yarn/pnpm directly, no shell interpreter
        const { stdout, stderr } = await execFileAsync(
          packageManagerCmd,
          ["run", scriptName],
          { cwd, timeout: 120_000, shell: false },
        );
        const durationMs = Math.round(performance.now() - start);
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        verdicts.push({
          passed: true,
          details: output.trim().substring(0, 500) || "Passed (no output)",
          durationMs,
        });
      } catch (error: any) {
        const durationMs = Math.round(performance.now() - start);
        verdicts.push({
          passed: false,
          details: (error.stdout || error.message || String(error)).substring(0, 500),
          durationMs,
        });
      }
    }

    const allPassed = verdicts.every((v) => v.passed);

    results.push({
      id: entry.id,
      strategy: entry.strategy,
      worktreePath: entry.worktree.path,
      workspaceId: entry.workspaceId,
      allPassed,
      verdicts,
    });
  }

  const passedCount = results.filter((r) => r.allPassed).length;

  // If all failed and all have the same node_modules diagnostic, add a top-level hint
  const allMissingDeps = passedCount === 0 && results.every(r => r.diagnostic?.includes("node_modules"));
  const judgeNote = allMissingDeps
    ? "All strategies are missing dependencies. The failures are not due to code issues. Use worktree_install_deps with each workspaceId to install dependencies, then call tournament_judge again."
    : undefined;

  // Store verdicts
  for (let i = 0; i < entries.length; i++) {
    entries[i].verdict = results[i].verdicts[0];
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tournamentId: input.tournamentId,
            summary: `${passedCount}/${results.length} strategies passed all checks.`,
            results,
            nextStep:
              passedCount > 0
                ? "Review the results and call tournament_cleanup to tear down losing worktrees, or declare a winner."
                : "All strategies failed. Check the details and iterate.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// --- tournament_cleanup ---

export interface TournamentCleanupInput {
  tournamentId: string;
  winnerPath?: string;
}

export async function tournamentCleanupTool(input: TournamentCleanupInput): Promise<ToolResponse> {
  const entries = activeTournaments.get(input.tournamentId);
  if (!entries) {
    return {
      content: [{ type: "text", text: `Tournament "${input.tournamentId}" not found.` }],
      isError: true,
    };
  }

  const cleaned: string[] = [];
  const errors: string[] = [];
  let winnerKept = false;

  for (const entry of entries) {
    // If winnerPath specified, skip that worktree
    if (input.winnerPath && entry.worktree.path === input.winnerPath) {
      winnerKept = true;
      cleaned.push(`${entry.id}: ${entry.strategy} — KEPT as winner`);
      continue;
    }

    try {
      await removeManagedWorktree({
        worktreePath: entry.worktree.path,
        sourceRoot: entry.worktree.sourceRoot,
      });
      cleaned.push(`${entry.id}: ${entry.strategy} — removed`);
    } catch (error: any) {
      errors.push(`${entry.id}: ${error.message}`);
    }
  }

  activeTournaments.delete(input.tournamentId);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tournamentId: input.tournamentId,
            winnerKept,
            cleaned,
            errors: errors.length > 0 ? errors : undefined,
            message: winnerKept
              ? "Winner worktree preserved. Use open_workspace to resume working in it."
              : "All tournament worktrees cleaned up.",
          },
          null,
          2,
        ),
      },
    ],
  };
}
