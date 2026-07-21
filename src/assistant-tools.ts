import { assertCommandAllowed } from "./security/command-executor.js";
import { collectPackageScriptCommands } from "./security/script-resolver.js";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { enforceSecurePath, type ToolResponse } from "./pi-tools.js";
import { getWorkspaceGitEligibility } from "./git.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceSummaryInput {}

export async function workspaceSummaryTool(cwd: string): Promise<ToolResponse> {
  const isGitRepo = existsSync(join(cwd, ".git"));
  let packageJson: any = null;
  
  try {
    const pkgContent = readFileSync(join(cwd, "package.json"), "utf8");
    packageJson = JSON.parse(pkgContent);
  } catch (e) {
    // Ignore
  }

  let topLevel: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    topLevel = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).slice(0, 50);
  } catch (e) {
    // Ignore
  }

  const summary = {
    root: cwd,
    isGitRepo,
    hasPackageJson: !!packageJson,
    name: packageJson?.name,
    version: packageJson?.version,
    scripts: packageJson?.scripts,
    dependencies: packageJson?.dependencies ? Object.keys(packageJson.dependencies) : [],
    devDependencies: packageJson?.devDependencies ? Object.keys(packageJson.devDependencies) : [],
    topLevel
  };

  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
  };
}

export interface ReadManyInput {
  paths: string[];
  compressionLevel?: "none" | "light" | "balanced" | "aggressive" | "skeletal";
  maxTokens?: number;
}

export async function readManyTool(input: ReadManyInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  let result = "";
  let totalTokens = 0;
  const maxTokens = input.maxTokens ?? 64000;

  // Proactive bloat warning: 5+ files without compression is a context risk
  const bloatWarning =
    input.paths.length >= 5 && (!input.compressionLevel || input.compressionLevel === "none")
      ? `⚠️  CONTEXT BLOAT WARNING: ${input.paths.length} files requested without compression. ` +
        `Consider setting compressionLevel to 'light' or 'balanced', or using semantic_pack for a goal-focused overview. ` +
        `Proceeding with maxTokens=${maxTokens} budget guard.\n\n`
      : "";

  const { statSync } = await import("node:fs");

  // Sort files by size (smallest first) to maximize what fits in budget
  type FileEntry = { path: string; fullPath: string; stat: import("node:fs").Stats };
  const files: FileEntry[] = [];
  for (const p of input.paths) {
    try {
      const fullPath = enforceSecurePath(p, cwd, [cwd], false);
      files.push({ path: p, fullPath, stat: statSync(fullPath) });
    } catch {}
  }
  files.sort((a, b) => a.stat.size - b.stat.size);

  const skipped: { path: string; reason: string }[] = [];
  for (const file of files) {
    const p = file.path;
    try {
      let content = readFileSync(file.fullPath, "utf8");

      // Apply compression if requested — pass filePath+mtime to benefit from AST cache
      if (input.compressionLevel && input.compressionLevel !== "none") {
        const { compressAST } = await import("./context-engine/compressors.js");
        const compressed = compressAST(content, input.compressionLevel, undefined, file.fullPath, file.stat.mtimeMs);
        content = compressed.output;
      }

      const estimatedTokens = Math.ceil(content.length / 4);
      if (totalTokens + estimatedTokens > maxTokens) {
        skipped.push({ path: p, reason: `exceeds remaining budget of ~${Math.max(0, maxTokens - totalTokens)} tokens (estimated ~${estimatedTokens})` });
        continue;
      }

      result += `\n--- ${p} ---\n${content}\n`;
      totalTokens += estimatedTokens;
    } catch (e: any) {
      result += `\n--- ${p} ---\nError: ${e.message}\n`;
    }
  }
  
  // Append skipped files summary
  if (skipped.length > 0) {
    result += `\n[SKIPPED files (use read_compressed with a compression level to fit):\n${skipped.map(s => `  - ${s.path}: ${s.reason}`).join("\n")}]\n`;
  }
  
  result = `${bloatWarning}[Token budget: ~${totalTokens} used of ${maxTokens}]\n` + result;
  return {
    content: [{ type: "text", text: result }]
  };
}

export interface SafeFilePreviewInput {
  paths: string[];
}

export async function safeFilePreviewTool(input: SafeFilePreviewInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const result: any[] = [];
  for (const p of input.paths) {
    try {
      const fullPath = enforceSecurePath(p, cwd, [cwd], false);
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split('\n');

      // Collect imports: handle multi-line import blocks (lines ending with { without closing })
      const imports: string[] = [];
      let buffer = "";
      let inBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!inBlock) {
          if (trimmed.startsWith('import ') || trimmed.match(/^const .+= require\(/)) {
            if (trimmed.includes('{') && !trimmed.includes('}') && !trimmed.endsWith(';')) {
              buffer = trimmed; // start multi-line block
              inBlock = true;
            } else {
              imports.push(trimmed);
            }
          }
        } else {
          buffer += " " + trimmed;
          if (trimmed.includes('}') || trimmed.endsWith(';')) {
            imports.push(buffer.replace(/\s+/g, ' ').trim());
            buffer = "";
            inBlock = false;
          }
        }
        if (imports.length >= 20) break;
      }

      const exports = lines
        .filter(l => l.trim().startsWith('export '))
        .slice(0, 20)
        .map(l => l.trim());

      result.push({
        path: p,
        approxLines: lines.length,
        importCount: imports.length,
        exportCount: exports.length,
        imports,
        exports,
      });
    } catch (e: any) {
      result.push({ path: p, error: e.message });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}

export interface GitToolInput {
  staged?: boolean;
  path?: string;
  maxCount?: number;
}

export async function gitTool(subCommand: string, input: GitToolInput, cwd: string): Promise<ToolResponse> {
  try {
    const eligibility = await getWorkspaceGitEligibility(cwd);
    if (!eligibility.ok) {
      return { content: [{ type: "text", text: `Git ${subCommand} unavailable: ${eligibility.message ?? "workspace is not a Git repository."}` }], isError: true };
    }
    const args: string[] = [subCommand];

    if (subCommand === "diff" && input.staged) {
      args.push("--cached");
    }
    if (subCommand === "log") {
      args.push("--no-color");
      if (input.maxCount) {
        args.push(`-n`, String(input.maxCount));
      } else {
        args.push("-n", "10");
      }
    }
    if (input.path) {
      args.push("--", input.path);
    }

    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
    const trimmed = output.trim();
    if (!trimmed) {
      if (subCommand === "diff") {
        return { content: [{ type: "text", text: "No tracked-file diff. There may be untracked files; use git_status or changed_files_summary to inspect." }] };
      }
      if (subCommand === "log") {
        return { content: [{ type: "text", text: "No commits found." }] };
      }
      return { content: [{ type: "text", text: "Success (no output)" }] };
    }
    return {
      content: [{ type: "text", text: trimmed }]
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: error.message || String(error) }],
      isError: true
    };
  }
}

export interface TreeToolInput {
  path?: string;
  depth?: number;
}

export async function treeTool(input: TreeToolInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const targetPath = enforceSecurePath(input.path || ".", cwd, [cwd], false);
  const maxDepth = input.depth ?? 3;
  
  const lines: string[] = [];
  
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: targetPath });
    const files = stdout.split(/\r?\n/).filter(Boolean);
    if (files.length === 0) {
      throw new Error("No files tracked or fallback to walk");
    }
    
    const root: Record<string, any> = {};
    for (const file of files) {
      const parts = file.split('/');
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          current[part] = null;
        } else {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      }
    }
    
    function buildStr(node: Record<string, any>, prefix: string, currentDepth: number) {
      if (currentDepth > maxDepth || lines.length >= 500) return;
      
      const keys = Object.keys(node).sort((a,b) => {
        const aIsDir = node[a] !== null;
        const bIsDir = node[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });
      
      for (let i = 0; i < keys.length; i++) {
        if (lines.length >= 500) {
          lines.push(`${prefix}└── (truncated)`);
          return;
        }
        const key = keys[i];
        const isLast = i === keys.length - 1;
        const marker = isLast ? "└── " : "├── ";
        const isDir = node[key] !== null;
        
        lines.push(`${prefix}${marker}${key}${isDir ? '/' : ''}`);
        
        if (isDir) {
          const childPrefix = prefix + (isLast ? "    " : "│   ");
          buildStr(node[key], childPrefix, currentDepth + 1);
        }
      }
    }
    
    buildStr(root, "", 1);
    
    return {
      content: [{ type: "text", text: lines.join('\n') || "(empty)" }]
    };
    
  } catch {
    // Fallback to original walk
    async function walk(dir: string, currentDepth: number, prefix: string) {
      if (currentDepth > maxDepth || lines.length >= 500) return;
      
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      
      entries = entries.filter(e => !['.git', 'node_modules', 'dist', 'build'].includes(e.name));
      
      for (let i = 0; i < entries.length; i++) {
        if (lines.length >= 500) {
          lines.push(`${prefix}└── (truncated)`);
          break;
        }
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const marker = isLast ? "└── " : "├── ";
        
        lines.push(`${prefix}${marker}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        
        if (entry.isDirectory()) {
          const nextPrefix = prefix + (isLast ? "    " : "│   ");
          await walk(join(dir, entry.name), currentDepth + 1, nextPrefix);
        }
      }
    }
    
    await walk(targetPath, 1, "");
    
    return {
      content: [{ type: "text", text: lines.join('\n') || "(empty)" }]
    };
  }
}

export interface RunScriptInput {
  script: string;
  outputMode?: "full" | "summary" | "diagnostic-summary";
}

export async function runScriptTool(input: RunScriptInput, cwd: string): Promise<ToolResponse> {
  try {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) {
      return {
        content: [{ type: "text", text: `package.json not found in ${cwd}. Cannot run package scripts.` }],
        isError: true,
        structuredContent: { status: "invalid_configuration", cwd, message: "package.json not found" },
      };
    }
    const pkgText = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgText);
    const availableScripts = pkg.scripts ? Object.keys(pkg.scripts) : [];

    if (!pkg.scripts || !pkg.scripts[input.script]) {
      return {
        content: [{ type: "text", text: `Script "${input.script}" not found in package.json. Available scripts: ${availableScripts.join(', ') || 'none'}` }],
        isError: true,
        structuredContent: { status: "script_not_found", cwd, message: `Script "${input.script}" not found` },
      };
    }

    // Detect the actual package manager from lockfiles
    const packageManager = existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";
    const fullCommand = `${packageManager} run ${input.script}`;


    const commandsToValidate = collectPackageScriptCommands({
      packageJson: pkg,
      scriptName: input.script,
      maxDepth: 10,
    });

    for (const cmd of commandsToValidate) {
      await assertCommandAllowed({
        command: cmd,
        workspaceRoot: cwd,
        workingDirectory: cwd,
        source: "package-script",
      });
    }

    await assertCommandAllowed({
      command: fullCommand,
      workspaceRoot: cwd,
      workingDirectory: cwd,
      source: "bash",
    });

    const { runProcess } = await import("./process-runner/index.js");
    const result = await runProcess(packageManager, ["run", input.script], { cwd });
    
    let stdout = result.status === "success" || result.status === "command_failed" || result.status === "timeout" || result.status === "cancelled" ? result.stdout : "";
    let stderr = result.status === "success" || result.status === "command_failed" || result.status === "timeout" || result.status === "cancelled" ? result.stderr : (result as any).message || "";
    let exitCode = result.status === "success" ? 0 : (result.status === "command_failed" ? result.exitCode : -1);

    const duration = result.durationMs;
    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");

    if (input.outputMode === "diagnostic-summary") {
      const { compressLog } = await import("./diagnostics/log-compressor.js");
      const summary = compressLog(fullCommand, output, exitCode, undefined, cwd);
      
      // Resolve suggestedReads paths relative to cwd — vitest in monorepos emits
      // paths like "tests/smoke/file.test.ts" from apps/ subdirectory,
      // but read tool expects workspace-root-relative paths.
      const nextActions: any[] = [];
      if (summary.suggestedReads) {
        for (const sr of summary.suggestedReads) {
          let resolvedPath = resolve(cwd, sr.path);
          if (!existsSync(resolvedPath)) {
            // Monorepo fallback: search apps/*, packages/*, src/* subdirectories.
            for (const sub of ["apps", "packages", "src"]) {
              const subDir = join(cwd, sub);
              if (!existsSync(subDir)) continue;
              try {
                const entries = await readdir(subDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue;
                  const candidate = join(subDir, entry.name, sr.path);
                  if (existsSync(candidate)) {
                    resolvedPath = candidate;
                    break;
                  }
                }
              } catch {}
              if (existsSync(resolvedPath)) break;
            }
          }
          if (!existsSync(resolvedPath)) continue;

          // Always emit existing workspace-relative source paths. Framework internals
          // and unresolved/absolute paths cannot be used by the read tool safely.
          const { relative } = await import("node:path");
          const workspaceRelativePath = relative(cwd, resolvedPath).replace(/\\/g, "/");
          if (
            workspaceRelativePath === "" ||
            workspaceRelativePath === ".." ||
            workspaceRelativePath.startsWith("../") ||
            workspaceRelativePath.split("/").includes("node_modules")
          ) continue;
          nextActions.push({
            tool: "read",
            arguments: {
              path: workspaceRelativePath,
              startLine: sr.startLine ?? 1,
              endLine: sr.endLine ?? 50,
            },
            reason: resolvedPath !== sr.path
              ? `Diagnostic referenced ${sr.path} — resolved to ${workspaceRelativePath}`
              : `Suggested by diagnostic: ${summary.summary?.primaryError?.message || "error context"}`,
            priority: nextActions.length === 0 ? 1 : 2,
          });
        }
      }
      
      // Attach the detected package manager + nextActions to the structured summary
      return {
        content: [{ type: "text", text: JSON.stringify({ packageManager, ...summary, nextActions }, null, 2) }]
      };
    }

    // 'summary' mode: compact output with command, status, duration, and last relevant lines
    if (input.outputMode === "summary") {
      const lines = output.split("\n").filter(Boolean);
      const tailCount = Math.min(20, lines.length);
      const tail = lines.slice(-tailCount);
      const isLong = lines.length > tailCount;
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            command: fullCommand,
            packageManager,
            status: result.status,
            exitCode,
            durationMs: duration,
            totalLines: lines.length,
            lastLines: isLong ? tail : undefined,
            output: isLong ? undefined : output.trim(),
          }, null, 2)
        }],
        isError: result.status !== "success",
        structuredContent: result,
      };
    }

    if (result.status !== "success") {
       return {
         content: [{ type: "text", text: result.status === "timeout"
           ? `[timeout] Process exceeded ${(result as any).timeoutMs}ms; termination ${(result as any).termination?.confirmed ? "confirmed" : "requested"}.\n${output.trim()}`
           : result.status === "cancelled"
             ? `[cancelled] Process termination ${(result as any).termination?.confirmed ? "confirmed" : "requested"}.\n${output.trim()}`
             : result.status === "infrastructure_error" ? `[infrastructure_error] ${(result as any).message}` : output.trim() }],
         isError: true,
         structuredContent: result,
       };
    }

    return {
      content: [{ type: "text", text: output.trim() || "Success (no output)" }],
      structuredContent: result,
    };
  } catch (error: any) {
    const message = error.message || String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      structuredContent: {
        status: /not allowed|blocked by policy|policy/i.test(message) ? "policy_blocked" : "invalid_configuration",
        cwd,
        message,
      },
    };
  }
}
