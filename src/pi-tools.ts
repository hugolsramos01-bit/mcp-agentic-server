import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@hugolsramos01-bit/pi-coding-agent";
import { resolveWorkspacePath } from "./security/path-resolution.js";
import { assertPathOperationAllowed } from "./security/secret-policy.js";
import { assertCommandAllowed } from "./security/command-executor.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { expandHomePath } from "./roots.js";
import type { SecurityMode } from "./security/security-mode.js";
import { runProcess } from "./process-runner/index.js";
import { resolveShellCommand } from "./process-sessions.js";
import { workspaceProcessEnvironment } from "./workspace-environment.js";



export function enforceSecurePath(
  requestedPath: string | undefined,
  cwd: string,
  allowedRoots: string[],
  isWrite = false,
): string {
  const expanded = expandHomePath(requestedPath ?? cwd);
  const candidate = requestedPath
    ? isAbsolute(expanded)
      ? expanded
      : resolve(cwd, expanded)
    : resolve(cwd);

  let lastError: Error | undefined;

  for (const root of allowedRoots) {
    try {
      const resolved = resolveWorkspacePath(
        root,
        candidate,
        isWrite,
      );

      assertPathOperationAllowed(
        resolved.canonicalPath,
        isWrite ? "write" : "read",
      );

      return resolved.canonicalPath;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError ?? new Error(
    `Path is outside allowed roots: ${requestedPath}`,
  );
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
  structuredContent?: any;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  securityMode?: SecurityMode;
  workspaceId?: string;
  serverHost?: string;
  serverPort?: number;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function ensureManagedRipgrep(): Promise<string | undefined> {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(expandHomePath(process.env.PI_CODING_AGENT_DIR))
    : join(homedir(), ".pi", "agent");
  const managedPath = join(agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (existsSync(managedPath)) return managedPath;

  // Preserve the Pi tool's existing auto-install behavior without letting its
  // broad --hidden search touch the user's workspace. A disposable empty scope
  // is enough to make Pi resolve/download its managed ripgrep binary.
  const bootstrapRoot = mkdtempSync(join(tmpdir(), "agentic-rg-bootstrap-"));
  try {
    const tool = createGrepTool(bootstrapRoot);
    await tool.execute("agentic-rg-bootstrap", {
      pattern: "__agentic_rg_bootstrap__",
      path: bootstrapRoot,
      literal: true,
      limit: 1,
    });
  } catch {
    // The caller will surface the original executable failure if bootstrap did
    // not make a managed binary available.
  } finally {
    try { rmSync(bootstrapRoot, { recursive: true, force: true }); } catch {}
  }

  return existsSync(managedPath) ? managedPath : undefined;
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = enforceSecurePath(input.path, context.cwd, context.readRoots ?? [context.root], false);
  const tool = createReadTool(context.cwd);

  const result = await runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);

  if (!result.isError && result.content[0]?.type === "text") {
    try {
      const { statSync, readFileSync } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      
      const st = statSync(path);
      const buf = readFileSync(path);
      const contentHash = "sha256:" + createHash("sha256").update(buf).digest("hex");
      
      const text = result.content[0].text;
      result.structuredContent = {
        envelope: {
          status: "success",
          data: {
            content: text,
            contentHash,
            sizeBytes: st.size,
            mtimeNs: Number(st.mtimeMs) * 1000000,
          },
        }
      };
    } catch (e) {
      // Ignore stat errors if file doesn't exist or similar
    }
  }

  return result;
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = enforceSecurePath(input.path, context.cwd, [context.root], true);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = enforceSecurePath(input.path, context.cwd, [context.root], true);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  const targetPath = input.path ?? context.cwd;
  const path = enforceSecurePath(targetPath, context.cwd, [context.root], false);
  const scopedPath = relative(context.cwd, path).replace(/\\/g, "/") || ".";
  const include = (input as GrepToolInput & { include?: string }).include ?? input.glob;
  const args = [
    "--line-number",
    "--column",
    "--with-filename",
    "--color=never",
    "--hidden",
  ];
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (include) args.push("--glob", include);

  // Security exclusions come after caller-controlled include globs so a broad
  // or secret-targeting include cannot re-enable internal metadata or secrets.
  args.push(
    "--glob", "!.git/**",
    "--glob", "!**/.git/**",
    "--glob", "!.agentic-checkpoints/**",
    "--glob", "!**/.agentic-checkpoints/**",
    "--glob", "!nul",
    "--glob", "!**/nul",
    "--glob", "!.env",
    "--glob", "!.env.*",
    "--glob", "!**/.env",
    "--glob", "!**/.env.*",
    "--glob", "!*.pem",
    "--glob", "!**/*.pem",
    "--glob", "!*.key",
    "--glob", "!**/*.key",
    "--glob", "!*.p12",
    "--glob", "!**/*.p12",
    "--glob", "!*.pfx",
    "--glob", "!**/*.pfx",
    "--glob", "!id_rsa",
    "--glob", "!**/id_rsa",
    "--glob", "!id_ed25519",
    "--glob", "!**/id_ed25519",
  );
  args.push("--", input.pattern, scopedPath);

  const env = workspaceProcessEnvironment({
    serverHost: context.serverHost,
    serverPort: context.serverPort,
    workspaceId: context.workspaceId,
    workspaceRoot: context.root,
  });
  let result = await runProcess("rg", args, { cwd: context.cwd, timeoutMs: 30_000, env });
  if (result.status === "infrastructure_error" && result.code === "ENOENT") {
    const managedRipgrep = await ensureManagedRipgrep();
    if (managedRipgrep) {
      result = await runProcess(managedRipgrep, args, { cwd: context.cwd, timeoutMs: 30_000, env });
    }
  }
  if (result.status === "success") {
    return { content: [{ type: "text", text: result.stdout.trim() || "No matches found" }] };
  }
  if (result.status === "command_failed" && result.exitCode === 1) {
    return { content: [{ type: "text", text: "No matches found" }] };
  }

  const message = result.status === "command_failed"
    ? result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`
    : result.status === "timeout"
      ? `ripgrep timed out after ${result.timeoutMs}ms`
      : result.status === "cancelled"
        ? "ripgrep search was cancelled"
        : "message" in result
          ? result.message
          : "ripgrep failed";
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  const targetPath = input.path ?? context.cwd;
  const path = enforceSecurePath(targetPath, context.cwd, [context.root], false);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), { ...input, path }, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  const targetPath = input.path ?? context.cwd;
  const path = enforceSecurePath(targetPath, context.cwd, [context.root], false);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), { ...input, path }, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  await assertCommandAllowed({
    command: input.command,
    workspaceRoot: context.root,
    workingDirectory: context.cwd,
    source: "bash",
    securityMode: context.securityMode,
  });
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
  const env = workspaceProcessEnvironment({
    serverHost: context.serverHost,
    serverPort: context.serverPort,
    workspaceId: context.workspaceId,
    workspaceRoot: context.root,
    overrides: {
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GH_PAGER: "cat",
      CODEX_CI: "1",
    },
  });
  const shell = resolveShellCommand(input.command, process.platform, env);
  const result = await runProcess(shell.executable, shell.args, {
    cwd: context.cwd,
    timeoutMs: timeout * 1_000,
    env,
  });

  const stdout = "stdout" in result ? result.stdout : "";
  const stderr = "stderr" in result ? result.stderr : ("message" in result ? result.message : "");
  const output = [stdout.trimEnd(), stderr ? `STDERR:\n${stderr.trimEnd()}` : ""]
    .filter(Boolean)
    .join("\n");
  const content = [{ type: "text" as const, text: output || "(no output)" }];
  return {
    content,
    isError: result.status !== "success" || undefined,
    structuredContent: result,
  };
}
