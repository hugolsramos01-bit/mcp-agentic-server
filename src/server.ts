import { randomUUID } from "node:crypto";
import { verifyNativeDependencies } from "./native-dependency-verifier.js";
import { assertCommandAllowed } from "./security/command-executor.js";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { logEvent, requestPath, sessionIdPrefix } from "./logger.js";
import {
  editFileTool, findFilesTool, grepFilesTool, listDirectoryTool,
  readFileTool, runShellTool, writeFileTool, enforceSecurePath,
} from "./pi-tools.js";
import {
  workspaceSummaryTool, readManyTool, safeFilePreviewTool, gitTool, treeTool, runScriptTool,
} from "./assistant-tools.js";
import {
  projectBootstrapTool, codingContextTool, suggestChecksTool, monorepoMapTool, changedFilesSummaryTool,
} from "./bootstrap-tools.js";
import { nextRouteMapTool, payloadSchemaMapTool, fileDependenciesTool } from "./ast-tools.js";
import {
  checkpointSaveTool, checkpointListTool, checkpointRestoreTool, checkpointDeleteTool,
} from "./checkpoint-tools.js";
import { proposePlanTool } from "./contract-tools.js";
import { checkEditAllowed, recordPlan, recordDryRun, recordCheckpoint, recordCheckpointRestore, recordChange, markChangesShown, getChangeSummary, getSessionActivity, getSessionLedger, resetSession as resetPvdlState } from "./change-session.js";
import { semanticPackTool, contextBudgetTool } from "./semantic-tools.js";
import { knowledgeCaptureTool, knowledgeSearchTool } from "./knowledge-tools.js";
import { tournamentSpawnTool, tournamentJudgeTool, tournamentCleanupTool } from "./tournament-tools.js";
import { assessCommand } from "./policy-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary, getLocalAgentProviderAvailabilitySnapshot, type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import {
  WORKSPACE_APP_URI,
  toolWidgetDescriptorMeta, serverInstructions, formatVisibleAgent, formatUnavailableAgentProvider,
  resultOutputSchema, workspaceSkillOutputSchema, workspaceAgentsFileOutputSchema,
  workspaceLocalAgentOutputSchema, workspaceLocalAgentProviderOutputSchema,
  workspaceAvailableAgentsFileOutputSchema, reviewFileOutputSchema, reviewSummaryOutputSchema,
  sendJsonRpcError, requestLogFields, logToolCall, logFailedToolResponse,
  textBlock, contentText, textSummary, contentLineCount, countDiffStats, newFilePatch,
  workspaceAppHtml, appCsp, uiBuildDirectory, setAssetHeaders, assertWorkspaceAppAssets,
  toolNames, WRITE_TOOL_ANNOTATIONS, EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS, READ_TOOL_ANNOTATIONS,
  type ToolContent, type ToolLogFields,
} from "./server/tool-utils.js";
import { processResult, processOutputSchema, processToolResponse } from "./server/process-tools.js";
import { agenticDoctor } from "./diagnostics.js";

type Transport = StreamableHTTPServerTransport;

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): void;
}



function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
): McpServer {
  const server = new McpServer(
    {
      name: "agentic",
      title: "Agentic MCP",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerAppResource(
    server,
    "Agentic MCP Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing Agentic MCP file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "agentic_doctor",
    {
      title: "Agentic Doctor",
      description: "Report the running Agentic MCP version, process-runner health, and local package-manager availability without changing a workspace.",
      inputSchema: {},
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_TOOL_ANNOTATIONS,
    },
      async () => {
      const report = await agenticDoctor();
      const text = JSON.stringify(report, null, 2);
      // resultOutputSchema requires a result field. Keep the full report in the
      // text payload and provide the schema-compatible summary field as well.
      return { content: [textBlock(text)], structuredContent: { result: text } };
    },
  );

    registerAppTool(
      server,
      "worktree_teardown",
      {
        title: "Worktree Teardown",
        description: "[General] Removes a managed git worktree that was created via open_workspace(mode: 'worktree'). If the worktree has uncommitted changes, pass force=true to discard them.",
        inputSchema: { workspaceId: z.string(), force: z.boolean().optional().describe("Force teardown even if worktree has uncommitted changes") },
        ...toolWidgetDescriptorMeta(config, "shell"),
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        if (workspace.mode !== "worktree" || !workspace.worktree?.managed) {
          const err = "Error: Workspace is not a managed worktree.";
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
        
        try {
          const { removeManagedWorktree } = await import("./git-worktrees.js");
          await removeManagedWorktree({
            worktreePath: workspace.worktree.path,
            sourceRoot: workspace.sourceRoot!,
            force: req.force ?? false,
          });
          const msg = "Successfully removed managed worktree.";
          return { content: [{ type: "text", text: msg }], structuredContent: { result: msg } };
        } catch (e: any) {
          const err = "Error removing worktree: " + e.message;
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
      }
    );

    registerAppTool(
      server,
      "worktree_sync_changes",
      {
        title: "Worktree Sync Changes",
        description: "[General] Copies uncommitted changes from the main workspace to this managed worktree sandbox.",
        inputSchema: { workspaceId: z.string() },
        ...toolWidgetDescriptorMeta(config, "shell"),
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        if (workspace.mode !== "worktree" || !workspace.worktree?.managed) {
          const err = "Error: Workspace is not a managed worktree.";
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
        
        try {
          const cp = await import("node:child_process");
          const util = await import("node:util");
          const execFileAsync = util.promisify(cp.execFile);
          
          const { stdout: diffData } = await execFileAsync("git", ["diff", "--binary", "HEAD"], { cwd: workspace.sourceRoot!, maxBuffer: 10 * 1024 * 1024 });
          if (!diffData || diffData.trim() === "") {
            const msg = "No uncommitted changes found in the main workspace.";
            return { content: [{ type: "text", text: msg }], structuredContent: { result: msg } };
          }
          
          const child = cp.execFile("git", ["apply", "--3way"], { cwd: workspace.worktree.path });
          child.stdin!.write(diffData);
          child.stdin!.end();
          
          await new Promise<void>((resolve, reject) => {
            child.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error("git apply failed with code " + code));
            });
          });
          
          const msg = "Successfully synced uncommitted changes to sandbox.";
          return { content: [{ type: "text", text: msg }], structuredContent: { result: msg } };
        } catch (e: any) {
          const err = "Error syncing changes: " + e.message;
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
      }
    );

    registerAppTool(
      server,
      "worktree_install_deps",
      {
        title: "Worktree Install Dependencies",
        description: "[General] Hydrates dependencies (e.g., npm install or pnpm install) inside a managed git worktree sandbox.",
        inputSchema: {
          workspaceId: z.string(),
          verify: z.boolean().optional().describe("Load declared native runtime dependencies after installation to verify the installed binding."),
          allowLifecycleScripts: z.boolean().optional().describe("Explicitly permit package lifecycle scripts in this isolated worktree. Required when native packages must build during installation."),
        },
        ...toolWidgetDescriptorMeta(config, "shell"),
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        if (workspace.mode !== "worktree" || !workspace.worktree?.managed) {
          const err = "Error: Workspace is not a managed worktree.";
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
        
        try {
          const fs = await import("node:fs");
          const pathModule = await import("node:path");
          const { runProcess } = await import("./process-runner/index.js");
          
          let cmd = "npm";
          const skipLifecycleScripts = !req.allowLifecycleScripts;
          let args = ["ci", ...(skipLifecycleScripts ? ["--ignore-scripts"] : [])];
          let pkgManager = "npm";

          if (fs.existsSync(pathModule.join(workspace.worktree.path, "pnpm-lock.yaml"))) {
            cmd = "pnpm";
            args = ["install", "--frozen-lockfile", ...(skipLifecycleScripts ? ["--ignore-scripts"] : [])];
            pkgManager = "pnpm";
          } else if (fs.existsSync(pathModule.join(workspace.worktree.path, "yarn.lock"))) {
            cmd = "yarn";
            args = ["install", "--immutable", ...(skipLifecycleScripts ? ["--ignore-scripts"] : [])];
            pkgManager = "yarn";
          }
          
          const result = await runProcess(cmd, args, { cwd: workspace.worktree.path });

          if (result.status !== "success") {
            const errResult = result.status === "infrastructure_error" || result.status === "timeout" || result.status === "cancelled"
              ? `Infrastructure Error: ${result.status === "timeout" ? `Timeout after ${result.timeoutMs}ms` : result.status === "cancelled" ? "Cancelled" : (result as any).message}`
              : `Install Failed (Exit code ${result.status === "command_failed" ? result.exitCode : -1}): ${(result as any).stderr || (result as any).message}`;
            return {
              content: [{ type: "text", text: errResult }],
              isError: true,
              structuredContent: result
            };
          }

          // Extract meaningful summary from pnpm/npm output instead of raw progress spam
          const fullOutput = result.stdout + "\n" + result.stderr;
          const lines = fullOutput.split("\n").filter(Boolean);
          
          // Parse pnpm-style summary: "packages: 910", "Done in 42.8s"
          const packagesDone = lines.find((l: string) => l.match(/^packages:\s+\d+/));
          const doneIn = lines.find((l: string) => l.match(/^Done in/));
          const progressLines = lines.filter((l: string) => !l.startsWith("Progress:") && !l.startsWith("Scope:"));
          const summaryLines = progressLines.slice(Math.max(0, progressLines.length - 5));
          
          let verification: { status: "installed_unverified" | "installed_verified" | "verification_skipped" | "verification_failed"; packages?: string[]; message: string } = {
            status: "installed_unverified",
            message: "Lifecycle scripts were skipped, so native/runtime dependencies were not loaded. Use verify: true to run a focused smoke check when supported.",
          };
          if (req.verify) {
            const packageJsonPath = pathModule.join(workspace.worktree.path, "package.json");
            const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) : {};
            const allDependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) };
            const nativeCandidates = Object.keys(allDependencies).filter((name) => /^(better-sqlite3|sqlite3|node-pty|sharp|canvas|bcrypt|argon2|esbuild)$/.test(name));
            if (nativeCandidates.length === 0) {
              verification = { status: "verification_skipped", message: "No supported native dependency was declared for a meaningful runtime smoke check; installation remains unverified." };
            } else {
              const smoke = verifyNativeDependencies(workspace.worktree.path, nativeCandidates);
              verification = smoke.ok
                ? { status: "installed_verified", packages: nativeCandidates, message: "Native runtime dependency smoke check passed." }
                : { status: "verification_failed", packages: nativeCandidates, message: `Install completed, but runtime verification failed: ${smoke.failures.map((failure) => `${failure.name}: ${failure.message}`).join("; ")}. Re-run with allowLifecycleScripts: true only if you trust this worktree and the dependency needs to build.` };
            }
          }

          const summary = [
            `Dependencies installed with lifecycle scripts ${skipLifecycleScripts ? "disabled" : "enabled by explicit request"} (${pkgManager}).`,
            `Status: ${verification.status}. ${verification.message}`,
            result.durationMs ? `Duration: ${result.durationMs}ms` : null,
            packagesDone ? packagesDone.trim() : null,
            doneIn ? doneIn.trim() : null,
            "---",
            ...summaryLines.map((l: string) => l.trim()).filter(Boolean),
          ].filter(Boolean).join("\n");

          return {
            content: [{ type: "text", text: summary }],
            isError: verification.status === "verification_failed",
            structuredContent: {
              status: verification.status,
              packageManager: pkgManager,
              durationMs: result.durationMs,
              packages: packagesDone?.replace("packages:", "").trim(),
              lifecycleScriptsSkipped: skipLifecycleScripts,
              verification,
            }
          };
        } catch (e: any) {
          const err = "Error installing dependencies: " + e.message;
          return { content: [{ type: "text", text: err }], isError: true, structuredContent: { result: err } };
        }
      }
    );

    registerAppTool(
      server,
      "worktree_list",
      {
        title: "Worktree List",
        description: "Lists all currently active managed git worktrees created via open_workspace.",
        inputSchema: {},
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async () => {
        const { getManagedWorktrees } = await import("./git-worktrees.js");
        const list = getManagedWorktrees();
        const text = JSON.stringify({ activeSandboxes: list }, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: { result: text },
        };
      }
    );

    registerAppTool(
    server,
    "open_workspace",
    {
      title: "[CORE] Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        allowParentGitRoot: z
          .boolean()
          .optional()
          .describe("Only for mode=\"worktree\": explicitly allow a requested subdirectory to be promoted to its parent Git root, expanding workspace scope."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
        agents: z.array(workspaceLocalAgentOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ path, mode, baseRef, allowParentGitRoot }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef, allowParentGitRoot });
      if (config.widgets === "changes") {
        // The baseline must be captured before open_workspace returns. Running
        // this in the background races the first edit: a newly-created source
        // file can be absorbed into the baseline and omitted by show_changes.
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const visibleAgentProviders = config.subagents ? localAgentProviders : [];
      const visibleAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = visibleAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              agentProviders: visibleAgentProviders.length,
              agents: visibleAgents.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          agentProviders: visibleAgentProviders,
          agents: visibleAgents,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from. (Deprecated: use startLine)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        endLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to stop reading at."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      // ── #2 Secret-file guard ────────────────────────────────────────
      // Block reading files that commonly contain secrets.
      // .env.example and .env.sample are explicitly allowed.
      const normalizedInputPath = input.path.replace(/\\/g, "/").toLowerCase();
      const basename = normalizedInputPath.split("/").pop() ?? "";
      const isEnvFile = /^\.env(\.|$)/.test(basename);
      const isEnvExample = /^\.env\.(example|sample|template)$/.test(basename);
      const isPrivateKey = /\.(pem|key|p12|pfx)$/.test(basename) || basename === "id_rsa" || basename === "id_ed25519";
      if ((isEnvFile && !isEnvExample) || isPrivateKey) {
        const override = process.env["AGENTIC_ALLOW_SECRET_READ"] === "1";
        if (!override) {
          return {
            content: [{ type: "text", text: `Reading '${input.path}' is blocked — this file likely contains secrets (.env / private key). Set AGENTIC_ALLOW_SECRET_READ=1 to override.` }],
            isError: true,
          };
        }
      }
      // ────────────────────────────────────────────────────────────────


      const DEFAULT_READ_LIMIT = 250;
      const MAX_READ_LIMIT = 500;
      
      const offset = input.startLine ?? input.offset ?? 1;
      const requestedLimit = input.endLine ? (input.endLine - offset + 1) : (input.limit ?? DEFAULT_READ_LIMIT);
      
      if (requestedLimit <= 0) {
        return {
          content: [{ type: "text", text: "Invalid pagination: endLine must be greater than or equal to startLine/offset." }],
          isError: true
        };
      }
      
      const limit = Math.min(requestedLimit, MAX_READ_LIMIT);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath, offset, limit: limit + 1 }, // read one extra line to check hasMore
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (!response.isError && response.content[0]?.type === "text") {
        const text = response.content[0].text;
        const lines = text.split('\n');
        if (lines.length > limit) {
          lines.pop(); // remove the extra line
          response.content[0].text = lines.join('\n');
          response.content.push({ type: "text", text: `\n[Note: File has more lines. Use offset=${offset + limit} or startLine=${offset + limit} to read more.]` });
        }
      }

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    "read_compressed",
    {
      title: "Read compressed file",
      description: "[General] Read a file using AST-aware semantic compression. Use this to save tokens when exploring large files. Compression levels: 'light' (removes large objects), 'balanced' (removes function bodies but keeps signatures), 'aggressive' (removes all bodies and objects), 'skeletal' (keeps only top-level declarations).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier."),
        path: z.string().describe("File path to read, relative to workspace root."),
        level: z.enum(["none", "light", "balanced", "aggressive", "skeletal"]).describe("Compression level to apply."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_TOOL_ANNOTATIONS,
    } as any,
    async (req: any) => {
      const workspace = workspaces.getWorkspace(req.workspaceId);
//       workspaces.resolvePath(workspace, req.path);
      
      const fsModule = await import("node:fs");
      const pathModule = await import("node:path");
      const fullPath = enforceSecurePath(req.path, workspace.root, [workspace.root], false);
      
      if (!fsModule.existsSync(fullPath)) {
        return { content: [{ type: "text", text: "File does not exist." }], isError: true };
      }
      
      const stat = fsModule.statSync(fullPath);
      const content = fsModule.readFileSync(fullPath, "utf8");
      
      const { compressAST } = await import("./context-engine/compressors.js");
      const compressed = compressAST(content, req.level, undefined, fullPath, stat.mtimeMs);
      const text = JSON.stringify(compressed, null, 2);
      
      return {
        content: [{ type: "text", text }],
        structuredContent: { result: text },
      };
    }
  );

  // ─── read_adaptive ─────────────────────────────────────────
  // Automatic read mode selection based on file characteristics.
  // The model doesn't need to decide compression level — we pick
  // the best mode for the file size and context.
  registerAppTool(
    server,
    "read_adaptive",
    {
      title: "[CORE] Read Adaptive",
      description: "[CORE] Read a file with automatic compression. Small files (<300 lines) are returned in full; medium files (300-900) use balanced compression; large files (>900) use skeletal compression. Always use this instead of read or read_compressed unless you need explicit control over line ranges or compression level.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("File path to read, relative to workspace root."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_TOOL_ANNOTATIONS,
    } as any,
    async (req: any) => {
      const workspace = workspaces.getWorkspace(req.workspaceId);
//       workspaces.resolvePath(workspace, req.path);
      
      const fsModule = await import("node:fs");
      const pathModule = await import("node:path");
      const fullPath = enforceSecurePath(req.path, workspace.root, [workspace.root], false);
      
      if (!fsModule.existsSync(fullPath)) {
        return { content: [{ type: "text", text: "File does not exist." }], isError: true };
      }
      
      const stat = fsModule.statSync(fullPath);
      const content = fsModule.readFileSync(fullPath, "utf8");
      const lines = content.split("\n").length;
      const isCode = req.path.endsWith(".ts") || req.path.endsWith(".tsx") || req.path.endsWith(".js") || req.path.endsWith(".jsx");
      
      // Adaptive logic: pick compression level based on file size
      let level: string;
      let reason: string;
      
      if (lines < 300) {
        level = "none";
        reason = `File is small (${lines} lines) — returned in full`;
      } else if (lines < 900) {
        level = "balanced";
        reason = `File is medium (${lines} lines) — balanced compression (keeps signatures, omits bodies)`;
      } else {
        level = "skeletal";
        reason = `File is large (${lines} lines) — skeletal compression (declarations only). Use expand_compressed_block to restore specific sections.`;
      }
      
      if (level === "none") {
        return {
          content: [{ type: "text", text: content }],
          structuredContent: {
            result: content,
            adaptive: { path: req.path, lines, level, reason },
          },
        };
      }
      
      const { compressAST } = await import("./context-engine/compressors.js");
      const compressed = compressAST(content, level as any, undefined, fullPath, stat.mtimeMs);
      const output = compressed.output;
      
      return {
        content: [{ type: "text", text: output }],
        structuredContent: {
          result: output,
          adaptive: {
            path: req.path,
            lines,
            level,
            reason,
            omissions: compressed.omissions,
            mustExpandBeforeEdit: compressed.metadata.mustExpandBeforeEdit,
            omittedBlocks: compressed.metadata.omittedBlocks,
            originalTokens: compressed.metadata.originalTokensEstimate,
            compressedTokens: compressed.metadata.outputTokensEstimate,
          },
        },
      };
    }
  );

  if (true) {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);

      // PVDL enforcement: check flow compliance before allowing edit
      const pvdl = checkEditAllowed(workspaceId, input.path, config.strictPvdl);
      if (!pvdl.allowed) {
        return { content: [{ type: "text", text: pvdl.reason! }], isError: true };
      }

      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      // Attach PVDL warning to the response if any step was skipped
      if (pvdl.warn && !response.isError) {
        response.content = [
          { type: "text", text: `⚠ ${pvdl.warn}` },
          ...response.content,
        ];
      }

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      
      // Record in ChangeSession
      recordChange(workspaceId, input.path, "edit", `${input.edits.length} change(s), +${stats.additions} -${stats.removals}`);
      
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
    if (config.legacyAliases) registerAppTool(
      server,
      "preview_edit",
      {
        title: "⚠️ DEPRECATED — Preview Edit (use edit_dry_run)",
        description:
          "⚠️ DEPRECATED — use edit_dry_run instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier."),
          path: z.string().describe("File path to edit, relative to the workspace root."),
          edits: z.array(z.object({
            oldText: z.string().describe("Exact text to replace."),
            newText: z.string().describe("Replacement text.")
          }))
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
//         workspaces.resolvePath(workspace, req.path);
        
        const pathModule = await import("node:path");
        const fullPath = enforceSecurePath(req.path, workspace.root, [workspace.root], false);
        
        const fsModule = await import("node:fs");
        if (!fsModule.existsSync(fullPath)) {
          return { content: [{ type: "text" as const, text: "File does not exist." }], isError: true, _meta: { tool: "preview_edit", card: { workspaceId: req.workspaceId, path: req.path, summary: "File not found", payload: { content: [] } } }, structuredContent: { result: "File does not exist." } };
        }
        
        let content = fsModule.readFileSync(fullPath, "utf8");
        let success = true;
        let errors = [];
        let additions = 0;
        let removals = 0;
        let previews = [];
        
        for (let i = 0; i < req.edits.length; i++) {
          const edit = req.edits[i];
          const count = content.split(edit.oldText).length - 1;
          if (count === 0) {
            success = false;
            errors.push(`Edit ${i + 1} failed: oldText not found.`);
          } else if (count > 1) {
            success = false;
            errors.push(`Edit ${i + 1} failed: oldText is not unique (found ${count} times).`);
          } else {
            content = content.replace(edit.oldText, edit.newText);
            removals += edit.oldText.split("\n").length;
            additions += edit.newText.split("\n").length;
            
            // Extract a preview window of ~3 lines before and after
            const idx = content.indexOf(edit.newText);
            const startIdx = Math.max(0, content.lastIndexOf("\n", idx - 50));
            const endIdx = content.indexOf("\n", idx + edit.newText.length + 50);
            previews.push(`--- Edit ${i + 1} Preview ---\n` + content.substring(startIdx, endIdx !== -1 ? endIdx : undefined).trim());
          }
        }
        
        if (!success) {
           const errContent = [{ type: "text" as const, text: `Preview failed:\n${errors.join("\n")}`}];
           return {
             content: errContent,
             isError: true,
             _meta: { tool: "preview_edit", card: { workspaceId: req.workspaceId, path: req.path, summary: "Preview failed", payload: { content: errContent } } },
             structuredContent: { result: `Preview failed:\n${errors.join("\n")}` }
           };
        }
        
        const successContent = [{ type: "text" as const, text: `Preview Success: +${additions} -${removals} lines.\n\n${previews.join("\n\n")}\n\nEdit is safe to apply using the 'edit' tool.` }];
        return {
          content: successContent,
          _meta: { tool: "preview_edit", card: { workspaceId: req.workspaceId, path: req.path, summary: "Preview success", payload: { content: successContent } } },
          structuredContent: { result: `Preview Success: +${additions} -${removals} lines.\n\n${previews.join("\n\n")}\n\nEdit is safe to apply using the 'edit' tool.` }
        };
      }
    );
    registerAppTool(
      server,
      "edit_dry_run",
      {
        title: "[CORE] Edit Dry Run",
        description:
          "Read-only dry run for exact-text replacement. Does not write to disk. Returns whether the replacement would match and a preview of changes.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier."),
          path: z.string().describe("File path to edit, relative to the workspace root."),
          edits: z.array(z.object({
            oldText: z.string().describe("Exact text to replace."),
            newText: z.string().describe("Replacement text.")
          }))
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        try {
          const workspace = workspaces.getWorkspace(req.workspaceId);
//           workspaces.resolvePath(workspace, req.path);
          
          const pathModule = await import("node:path");
          const fullPath = enforceSecurePath(req.path, workspace.root, [workspace.root], false);
          
          const fsModule = await import("node:fs");
          if (!fsModule.existsSync(fullPath)) {
            return { content: [{ type: "text" as const, text: "File does not exist." }], isError: true, _meta: { tool: "edit_dry_run", card: { workspaceId: req.workspaceId, path: req.path, summary: "File not found", payload: { content: [] } } }, structuredContent: { result: "File does not exist." } };
          }
          
          let content = fsModule.readFileSync(fullPath, "utf8");
          let success = true;
          let errors = [];
          let additions = 0;
          let removals = 0;
          let previews = [];
          
          for (let i = 0; i < req.edits.length; i++) {
            const edit = req.edits[i];
            const count = content.split(edit.oldText).length - 1;
            if (count === 0) {
              success = false;
              errors.push(`Edit ${i + 1} failed: oldText not found.`);
            } else if (count > 1) {
              success = false;
              errors.push(`Edit ${i + 1} failed: oldText is not unique (found ${count} times).`);
            } else {
              content = content.replace(edit.oldText, edit.newText);
              removals += edit.oldText.split("\n").length;
              additions += edit.newText.split("\n").length;
              
              const idx = content.indexOf(edit.newText);
              const startIdx = Math.max(0, content.lastIndexOf("\n", idx - 50));
              const endIdx = content.indexOf("\n", idx + edit.newText.length + 50);
              previews.push(`--- Edit ${i + 1} Preview ---\n` + content.substring(startIdx, endIdx !== -1 ? endIdx : undefined).trim());
            }
          }
          
          if (!success) {
             const errContent = [{ type: "text" as const, text: `Preview failed:\n${errors.join("\n")}`}];
             return {
               content: errContent,
               isError: true,
               _meta: { tool: "edit_dry_run", card: { workspaceId: req.workspaceId, path: req.path, summary: "Preview failed", payload: { content: errContent } } },
               structuredContent: { result: `Preview failed:\n${errors.join("\n")}` }
             };
          }
          
          const successContent = [{ type: "text" as const, text: `Preview Success: +${additions} -${removals} lines.\n\n${previews.join("\n\n")}\n\nEdit is safe to apply using the 'edit' tool.` }];
          recordDryRun(req.workspaceId, req.path, JSON.stringify(req.edits));
          return {
            content: successContent,
            _meta: { tool: "edit_dry_run", card: { workspaceId: req.workspaceId, path: req.path, summary: "Preview success", payload: { content: successContent } } },
            structuredContent: { result: `Preview Success: +${additions} -${removals} lines.\n\n${previews.join("\n\n")}\n\nEdit is safe to apply using the 'edit' tool.` }
          };
        } catch (err: any) {
          const errMsg = `Internal error in edit_dry_run: ${err.message}. The session is still active — try a different approach.`;
          return { content: [{ type: "text" as const, text: errMsg }], isError: true, structuredContent: { result: errMsg } };
        }
      }
    );
  }

  

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes for an open workspace. If the current turn successfully modified files, call this exactly once after the final related file change and before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual file change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          includeSessionHistory: z.boolean().optional().describe("Include historical edits made during this server session. The primary result always reflects the current workspace state."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: READ_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, includeSessionHistory = false }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        
        // Mark changes as shown in ChangeSession
        try { markChangesShown(workspaceId); } catch {}

        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
            currentWorkspaceChanges: review.files,
            ...(includeSessionHistory ? { sessionLedger: getSessionLedger(workspaceId), sessionActivity: getSessionActivity(workspaceId) } : {}),
          },
        };
      },
    );
  }

  if (config.toolMode === "full" || config.toolMode === "assistant") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "[CORE] Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
          limit: z.number().optional().describe("Maximum number of matches to return (default: 100)."),
          offset: z.number().optional().describe("Number of initial matches to skip (for pagination)."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);

        // Strip limit/offset before forwarding to Pi SDK (Pi's grep doesn't support them natively)
        const { limit: userLimit, offset: userOffset, ...piInput } = input as any;
        
        const response = await grepFilesTool(piInput, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        // Post-process: apply limit/offset client-side since Pi SDK doesn't support them
        const resultText = contentText(response.content) || "";
        // Normalize and sort the complete match set before paginating. The Pi
        // backend may return duplicates or filesystem-order-dependent output;
        // paging that raw stream creates overlapping pages.
        const matches = new Map<string, { line: string; path: string; row: number; column: number }>();
        for (const line of resultText.split("\n")) {
          const parsed = line.match(/^(.*):(\d+)(?::(\d+))?:(.*)$/);
          if (!parsed) continue;
          const path = parsed[1].replace(/\\/g, "/");
          const row = Number(parsed[2]);
          const column = Number(parsed[3] ?? 0);
          const key = `${path}\u0000${row}\u0000${column}\u0000${parsed[4]}`;
          matches.set(key, { line, path, row, column });
        }
        let lines = [...matches.values()]
          .sort((a, b) => a.path.localeCompare(b.path) || a.row - b.row || a.column - b.column || a.line.localeCompare(b.line))
          .map((match) => match.line);
        
        // Apply offset: skip first N results
        const offset = userOffset ?? 0;
        const limit = userLimit ?? (lines.length > 100 ? 100 : lines.length);
        
        if (offset > 0) {
          lines = lines.slice(offset);
        }
        const totalCount = lines.length;
        const paginatedLines = lines.slice(0, limit);
        const truncated = paginatedLines.length < lines.length;
        
        let finalContent = paginatedLines.join("\n") || resultText;
        if (truncated) {
          finalContent += `\n... [${totalCount - paginatedLines.length} more matches available. Pass offset=${offset + limit} for next page.]`;
        }
        
        // Replace Pi's "Use limit=N for more" message with actionable suggestions
        if (finalContent.includes("Use limit")) {
          finalContent = finalContent.replace(
            /Use limit=\d+ for more/,
            `Showing ${paginatedLines.length} of ${totalCount + offset} matches. Refine with a more specific pattern, path, or include filter.`
          );
        }

        const augmentedResponse = {
          ...response,
          content: [{ type: "text" as const, text: finalContent }],
        };

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          matchCount: paginatedLines.length,
          totalCount: totalCount + offset,
          truncated,
          offset,
          limit,
          ...textSummary(augmentedResponse.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...augmentedResponse,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: augmentedResponse.content },
            },
          },
          structuredContent: {
            result: contentText(augmentedResponse.content),
            summary: {
              matchCount: paginatedLines.length,
              totalCount: totalCount + offset,
              truncated,
              offset,
              limit,
              pattern: input.pattern,
              scope: input.path ?? ".",
            },
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "[CORE] Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        
        // Normalize glob patterns: strip leading **/ which Pi's find tool doesn't support
        let effectivePattern = input.pattern;
        let effectivePath = input.path;
        if (effectivePattern.startsWith("**/")) {
          effectivePattern = effectivePattern.substring(3);
        }
        
        if (effectivePath) workspaces.resolvePath(workspace, effectivePath);
        
        // Also handle pattern with embedded path separators
        if (!effectivePath && effectivePattern.includes("/")) {
          const lastSep = effectivePattern.lastIndexOf("/");
          effectivePath = effectivePattern.substring(0, lastSep);
          effectivePattern = effectivePattern.substring(lastSep + 1);
        }
        
        const response = await findFilesTool(
          { pattern: effectivePattern, path: effectivePath },
          { cwd: workspace.root, root: workspace.root },
        );

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: READ_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode === "assistant") {
    const getSummary = (tool: string, req: any) => {
      switch (tool) {
        case "workspace_summary": return "⚠️ DEPRECATED — Project Summary (use project_bootstrap)";
        case "read_many": return `Read ${req.paths?.length || 0} file(s)`;
        case "tree": return `Tree of ${req.path || '.'} (Depth: ${req.depth || 'unlimited'})`;
        case "safe_file_preview": return `Preview ${req.paths?.length || 0} file(s)`;
        case "git_status": return "Git Status";
        case "git_diff": return "Git Diff";
        case "git_log": return "Git Log";
        case "run_package_script": return `npm run ${req.script}`;
        case "checkpoint_save": return `Checkpoint: ${req.description || ''}`;
        case "checkpoint_list": return "Checkpoint List";
        case "checkpoint_restore": return `Restore: ${req.id}`;
        case "checkpoint_delete": return `Delete: ${req.id}`;
        case "next_routes_summary": return "Next Routes Summary";
        case "payload_collections_summary": return "Payload Collections Summary";
        case "check_recommendations": return "Check Recommendations";
        case "edit_dry_run": return "Edit Dry Run";
        case "git_changes_summary": return "Git Changes Summary";
        case "propose_plan": return `Plan: ${(req.goal || '').substring(0, 60)}`;
        case "tournament_spawn": return `Tournament: ${(req.strategies?.length || 0)} strategies`;
        case "tournament_judge": return `Judge: ${req.tournamentId}`;
        case "tournament_cleanup": return `Cleanup: ${req.tournamentId}`;
        case "risk_assess_command": return `Risk Assess: ${(req.command || '').substring(0, 40)}`;
        case "set_policy": return `Set Policy: ${req.rules?.length || 0} rules`;
        case "reset_policy": return "Reset Policy";
        default: return tool;
      }
    };

    const wrap = (tool: string, req: any, response: any, extra?: { nextActions?: any[], diagnostics?: any[], startedAt?: number }) => {
      const resultText = contentText(response.content);
      
      // Build universal envelope — every tool response includes:
      // - status: "success" | "error" (tool execution), with commandStatus when applicable
      // - summary: human-readable one-liner
      // - nextActions: directly callable follow-up suggestions
      // - metrics: durationMs, truncated
      const toolStatus = response.isError ? "error" : "success";
      
      // Detect command failure inside a successful tool execution
      // (e.g. test runner that exited non-zero but tool executed fine)
      let commandStatus: string | undefined;
      if (resultText.includes('"status": "failed"') || resultText.includes('"status":"failed"')) {
        commandStatus = "failed";
      } else if (resultText.includes('"exitCode":') || resultText.includes('"exitCode" :')) {
        // extract exit code
        const ecMatch = resultText.match(/"exitCode"\s*:\s*(\d+)/);
        if (ecMatch && parseInt(ecMatch[1]) !== 0) {
          commandStatus = "failed";
        }
      }
      
      const status = commandStatus === "failed" ? "failed" : toolStatus;
      // Auto-measure: if no startedAt provided, measure at wrap() entry as estimate.
      // This catches the wall-clock time spent in the handler (including awaits).
      const wrapEntryAt = performance.now();
      const durationMs = extra?.startedAt ? Math.round(performance.now() - extra.startedAt) : Math.round(performance.now() - (req.__startedAt ?? wrapEntryAt));
      if (!extra?.startedAt && !req.__startedAt) {
        // No startedAt available — durationMs will be 0. To fix, pass startedAt in wrap() calls.
      }
      
      return {
        ...response,
        _meta: {
          tool,
          card: {
            workspaceId: req.workspaceId,
            summary: getSummary(tool, req),
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: resultText,
          envelope: {
            status,
            summary: getSummary(tool, req),
            tool,
            nextActions: extra?.nextActions ?? [],
            diagnostics: extra?.diagnostics ?? [],
            metrics: {
              durationMs,
              truncated: resultText.includes("[truncated]") || resultText.includes("... [truncated"),
            },
          },
        },
      };
    };

    registerAppTool(
      server,
      "next_route_map",
      {
        title: "[ADVANCED] Next.js Route Map",
        description: "[Architecture] Read-only bounded summary of Next.js route files (app/ and pages/) inside the opened workspace. Does not execute code, does not write files, returns a compact limited result.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), appPath: z.string().optional().describe("Optional subdirectory for monorepos (e.g. 'apps/web')") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("next_route_map", req, await nextRouteMapTool(workspace.root, req.appPath));
      }
    );
    if (config.legacyAliases) registerAppTool(
      server,
      "next_routes_summary",
      {
        title: "⚠️ DEPRECATED — Next Routes Summary (use next_route_map)",
        description: "⚠️ DEPRECATED — use next_route_map instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), appPath: z.string().optional().describe("Optional subdirectory for monorepos (e.g. 'apps/web')") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("next_routes_summary", req, await nextRouteMapTool(workspace.root, req.appPath));
      }
    );
    registerAppTool(
      server,
      "payload_schema_map",
      {
        title: "[ADVANCED] Payload Schema Map",
        description: "Read-only bounded summary of Payload CMS collection schemas extracted via AST. Does not execute code, does not write files, and returns a compact limited result. For monorepos, pass appPath (e.g. 'apps/web') to scan a specific app subdirectory.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), appPath: z.string().optional().describe("Optional subdirectory for monorepos (e.g. 'apps/web')") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("payload_schema_map", req, await payloadSchemaMapTool(workspace.root, req.appPath));
      }
    );
    if (config.legacyAliases) registerAppTool(
      server,
      "payload_collections_summary",
      {
        title: "⚠️ DEPRECATED — Payload Collections Summary (use payload_schema_map)",
        description: "⚠️ DEPRECATED — use payload_schema_map instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), appPath: z.string().optional().describe("Optional subdirectory for monorepos") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("payload_collections_summary", req, await payloadSchemaMapTool(workspace.root, req.appPath));
      }
    );
    registerAppTool(
      server,
      "file_dependencies",
      {
        title: "[ADVANCED] File Dependencies",
        description: "[Architecture] Read-only analysis of file imports (outward) and dependents (inward) in the project. Does not execute code or modify files.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().describe("Target file path relative to workspace root") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("file_dependencies", req, await fileDependenciesTool(workspace.root, req.path));
      }
    );

    registerAppTool(
      server,
      "checkpoint_save",
      {
        title: "Save Checkpoint",
        description: "[Checkpoints] Saves a snapshot of current working tree changes (unstaged, staged, and untracked files) as a checkpoint in .agentic-checkpoints/. Use this before risky edits so you can restore later.",
        inputSchema: { workspaceId: z.string(), description: z.string().optional() },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: WRITE_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        const result = await checkpointSaveTool(workspace.root, req);
        if (!result.isError) {
          // Extract checkpoint ID from response to track in ChangeSession
          let cpId = "unknown";
          try { cpId = JSON.parse((result.content[0] as any).text).id || "unknown"; } catch {}
          recordCheckpoint(req.workspaceId, cpId, req.description);
        }
        return wrap("checkpoint_save", req, result);
      }
    );
    registerAppTool(
      server,
      "checkpoint_list",
      {
        title: "List Checkpoints",
        description: "[Checkpoints] Lists all saved checkpoints for the current workspace.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("checkpoint_list", req, await checkpointListTool(workspace.root));
      }
    );
    registerAppTool(
      server,
      "checkpoint_restore",
      {
        title: "Restore Checkpoint",
        description: "[Checkpoints] Restores working tree to a previously saved checkpoint state by reverting the diff.",
        inputSchema: { workspaceId: z.string(), id: z.string().describe("Checkpoint ID to restore (from checkpoint_list).") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: WRITE_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        const result = await checkpointRestoreTool(workspace.root, req);
        if (!result.isError) recordCheckpointRestore(req.workspaceId, req.id);
        return wrap("checkpoint_restore", req, result);
      }
    );
    registerAppTool(
      server,
      "checkpoint_delete",
      {
        title: "Delete Checkpoint",
        description: "[General] Deletes a saved checkpoint by ID.",
        inputSchema: { workspaceId: z.string(), id: z.string().describe("Checkpoint ID to delete.") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: WRITE_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("checkpoint_delete", req, await checkpointDeleteTool(workspace.root, req));
      }
    );

    registerAppTool(
      server,
      "coding_context",
      {
        title: "Coding Context",
        description: "[Context] Returns a compact workspace context: git, package manager, scripts, key routes, schemas, relevant instructions, and recommended next inspection points. For rich semantic overviews, prefer semantic_pack (which includes token budget and automatic file compression). Pass a goal to filter context items.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors"), goal: z.string().optional().describe("Optional: filter context to only items relevant to this goal (e.g. 'onboarding', 'dashboard', 'tenant')") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("coding_context", req, await codingContextTool(workspace.root, config.allowedRoots, { goal: req.goal }));
      }
    );
    registerAppTool(
      server,
      "suggest_checks",
      {
        title: "Suggest Checks",
        description: "[Execution] Read-only recommendation of package scripts based on workspace package.json. Does not execute scripts or commands.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("suggest_checks", req, await suggestChecksTool(workspace.root));
      }
    );
    registerAppTool(
      server,
      "risk_assess_command",
      {
        title: "Risk Assess Command",
        description: "[Security] Preview the active command-policy verdict without executing a command.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), command: z.string().describe("Command to assess") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const assessment = assessCommand(req.command);
        return wrap("risk_assess_command", req, { content: [{ type: "text", text: JSON.stringify(assessment, null, 2) }] });
      },
    );
    if (config.legacyAliases) registerAppTool(
      server,
      "check_recommendations",
      {
        title: "⚠️ DEPRECATED — Check Recommendations (use suggest_checks)",
        description: "⚠️ DEPRECATED — use suggest_checks instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("check_recommendations", req, await suggestChecksTool(workspace.root));
      }
    );
    registerAppTool(server, "project_bootstrap",
      {
        title: "[CORE] Project Bootstrap",
        description: "[Context] Returns high-level workspace context: package manager, git status, tree, capabilities (nextjs, payload, monorepo, etc.), and project instructions. Start here when you need to understand what kind of project this is and which tools are relevant.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        const { buildWorkspaceIndex } = await import("./workspace-index.js");
        const index = await buildWorkspaceIndex(req.workspaceId, workspace.root, config.allowedRoots);
        const treeRes = await (await import("./assistant-tools.js")).treeTool({ depth: 2 }, workspace.root, config.allowedRoots);
        const treeText = (treeRes.content[0] as any).text;
        const tree = treeText.startsWith("{") ? (JSON.parse(treeText).text || treeText) : treeText;
        return wrap("project_bootstrap", req, {
          content: [{ type: "text", text: JSON.stringify({ ...index.bootstrap, tree }, null, 2) }]
        });
      }
    );
    registerAppTool(
      server,
      "monorepo_map",
      {
        title: "[ADVANCED] Monorepo Map",
        description: "[Architecture] Read-only listing of monorepo apps and packages with their dependencies from apps/ and packages/ directories.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("monorepo_map", req, await monorepoMapTool(workspace.root));
      }
    );
    registerAppTool(
      server,
      "changed_files_summary",
      {
        title: "Changed Files Summary",
        description: "[Git] Read-only structured JSON summary of locally modified files based on git diff.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("changed_files_summary", req, await changedFilesSummaryTool(workspace.root));
      }
    );
    if (config.legacyAliases) registerAppTool(
      server,
      "git_changes_summary",
      {
        title: "⚠️ DEPRECATED — Git Changes Summary (use changed_files_summary)",
        description: "⚠️ DEPRECATED — use changed_files_summary instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("git_changes_summary", req, await changedFilesSummaryTool(workspace.root));
      }
    );

    registerAppTool(
      server,
      "propose_plan",
      {
        title: "[CORE] Propose Plan",
        description: "[PVDL] Log a structured plan before making changes. Follow PVDL flow: Plan first, then Verify with edit_dry_run, then Do with checkpoint_save + edit, then Log with suggested checks. When AGENTIC_STRICT_PVDL is enabled, this tool must be called before edit/write — the server will enforce the flow.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          goal: z.string().describe("What you intend to accomplish"),
          filesToRead: z.array(z.string()).optional().describe("Files to inspect before editing"),
          filesToChange: z.array(z.string()).optional().describe("Files to modify"),
          riskAreas: z.array(z.string()).optional().describe("Potential risks or areas of impact"),
          verificationPlan: z.array(z.string()).optional().describe("Checks to run after editing"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        return wrap("propose_plan", req, await proposePlanTool(req, req.workspaceId));
      }
    );

    registerAppTool(
      server,
      "knowledge_capture",
      {
        title: "Knowledge Capture",
        description: "[Knowledge] Save a decision, invariant, or lesson learned to the workspace knowledge base (.agentic/knowledge/decisions/). Call this after completing a task to persist hard-won insights for future sessions. ScopedTo limits when this knowledge is injected back into context.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          slug: z.string().describe("Short unique identifier for this knowledge entry"),
          summary: z.string().describe("One-line summary of the decision or insight"),
          scopedTo: z.array(z.string()).optional().describe("Optional scope tags (e.g. ['onboarding', 'sites', 'auth']) to control when this knowledge is injected"),
          content: z.string().describe("Detailed explanation of the decision, rejected alternatives, invariants, and reasoning"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("knowledge_capture", req, await knowledgeCaptureTool(workspace.root, req));
      }
    );
    registerAppTool(
      server,
      "knowledge_search",
      {
        title: "Knowledge Search",
        description: "[Knowledge] Read-only search of past decisions and insights from the workspace knowledge base (.agentic/knowledge/). Optionally filter by scope.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          scopedTo: z.array(z.string()).optional().describe("Optional scope tags to filter knowledge entries"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("knowledge_search", req, await knowledgeSearchTool(workspace.root, req));
      }
    );

    if (config.legacyAliases) registerAppTool(
      server,
      "workspace_summary",
      {
        title: "⚠️ DEPRECATED — Workspace Summary (use project_bootstrap)",
        description: "⚠️ DEPRECATED — use project_bootstrap instead. This alias is kept for backward compatibility but will be removed in a future version.",
        inputSchema: { workspaceId: z.string().describe("Workspace ID"), path: z.string().optional().describe("Ignored parameter to prevent schema errors") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("workspace_summary", req, await workspaceSummaryTool(workspace.root));
      }
    );
    registerAppTool(
      server,
      "read_many",
      {
        title: "Read Many Files",
        description: "Read the contents of multiple files in a single call. Use this instead of reading files one by one. Supports optional compressionLevel to reduce token usage: 'light' (removes large objects), 'balanced' (removes function bodies), 'aggressive', 'skeletal'. Use maxTokens to set a budget — files exceeding the budget are skipped.",
        inputSchema: {
          workspaceId: z.string(),
          paths: z.array(z.string()),
          compressionLevel: z.enum(["none", "light", "balanced", "aggressive", "skeletal"]).optional().describe("Optional compression level to reduce token usage"),
          maxTokens: z.number().optional().describe("Optional token budget (default 64000) — files are skipped once budget is exceeded"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("read_many", req, await readManyTool(req, workspace.root, config.allowedRoots));
      }
    );
    registerAppTool(
      server,
      "tree",
      {
        title: "Directory Tree",
        description: "[File System] Recursively list directory structure.",
        inputSchema: { workspaceId: z.string(), path: z.string().optional(), depth: z.number().optional() },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("tree", req, await treeTool(req, workspace.root, config.allowedRoots));
      }
    );
    registerAppTool(
      server,
      "safe_file_preview",
      {
        title: "File Preview",
        description: "[File System] Extracts imports and exports from large files to provide a quick summary.",
        inputSchema: { workspaceId: z.string(), paths: z.array(z.string()) },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("safe_file_preview", req, await safeFilePreviewTool(req, workspace.root, config.allowedRoots));
      }
    );
    registerAppTool(
      server,
      "git_status",
      {
        title: "[CORE] Git Status",
        description: "[Git] Read-only git status showing branch, staged, unstaged, and untracked files. Does not modify the repository.",
        inputSchema: { workspaceId: z.string() },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("git_status", req, await gitTool("status", req, workspace.root));
      }
    );
    registerAppTool(
      server,
      "git_diff",
      {
        title: "[CORE] Git Diff",
        description: "[Git] Read-only git diff showing uncommitted changes. Does not modify the repository.",
        inputSchema: { workspaceId: z.string(), staged: z.boolean().optional().describe("Show only staged changes"), path: z.string().optional().describe("Filter to specific file path") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("git_diff", req, await gitTool("diff", req, workspace.root));
      }
    );
    registerAppTool(
      server,
      "git_log",
      {
        title: "[CORE] Git Log",
        description: "[Git] Read-only git log showing recent commit history. Does not modify the repository.",
        inputSchema: { workspaceId: z.string(), maxCount: z.number().optional().describe("Maximum number of commits to show (default 10)"), path: z.string().optional().describe("Filter log to specific file path") },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("git_log", req, await gitTool("log", req, workspace.root));
      }
    );
    registerAppTool(
      server,
      "run_package_script",
      {
        title: "[CORE] Run Package Script",
        description: "[Execution] Runs an npm run script from the workspace's package.json. Use outputMode: 'diagnostic-summary' (or 'summary') to get a compact error/warning report instead of full build logs.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          script: z.string().describe("Script name from package.json"),
          outputMode: z.enum(["full", "diagnostic-summary", "summary"]).optional().describe("'full' for raw output (default), 'diagnostic-summary' or 'summary' for compact report with known warnings, errors, and suggested files to read."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("run_package_script", req, await runScriptTool(req, workspace.root));
      }
    );

    registerAppTool(
      server,
      "tournament_spawn",
      {
        title: "[ADVANCED] Spawn Tournament",
        description: "[Tournament] Spawn multiple managed git worktrees (one per strategy) from the same base ref for parallel experimentation. Each worktree is isolated; implement different strategies in each. After implementing, call tournament_judge to compare results.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID of the source project"),
          strategies: z.array(z.string()).min(2).max(5).describe("2-5 strategies to test in parallel. Each strategy should be a concise description of the approach."),
          installDependencies: z.boolean().optional().describe("Auto-install dependencies in each worktree after creation (default: false)"),
          allowParentGitRoot: z.boolean().optional().describe("Explicitly allow promotion from a requested subdirectory to its parent Git root. This expands the worktree scope."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("tournament_spawn", req, await tournamentSpawnTool({
          workspaceRoot: workspace.root,
          strategies: req.strategies,
          config,
          installDependencies: req.installDependencies ?? false,
          allowParentGitRoot: req.allowParentGitRoot === true,
          registerWorktree: (worktreePath: string, sourceRoot: string) =>
            workspaces.registerWorktree(worktreePath, sourceRoot),
        }));
      }
    );
    registerAppTool(
      server,
      "tournament_judge",
      {
        title: "[ADVANCED] Tournament Judge",
        description: "[Tournament] Run verification scripts on all tournament worktrees and compare results. Default: runs typecheck + build on each.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          tournamentId: z.string().describe("Tournament ID from tournament_spawn"),
          verificationScripts: z
            .array(z.string())
            .optional()
            .describe(
              "Names of package.json scripts to run for verification. Defaults to [\"typecheck\", \"build\"]. Must be exact script names — not shell commands.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        return wrap("tournament_judge", req, await tournamentJudgeTool(req));
      }
    );
    registerAppTool(
      server,
      "tournament_cleanup",
      {
        title: "[ADVANCED] Tournament Cleanup",
        description: "[Tournament] Tear down tournament worktrees. Optionally keep a winner. Set force=true only to discard uncommitted worktree changes.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          tournamentId: z.string().describe("Tournament ID from tournament_spawn"),
          winnerPath: z.string().optional().describe("Optional worktree path to keep as the winner"),
          force: z.boolean().optional().describe("Explicitly discard uncommitted changes in worktrees being removed."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        return wrap("tournament_cleanup", req, await tournamentCleanupTool(req));
      }
    );
    
    
    

    registerAppTool(
      server,
      "semantic_pack",
      {
        title: "[ADVANCED] Semantic Pack",
        description: "[Context] Returns a compact, goal-relevant semantic pack of the workspace. Combines project context, architecture, routes, collections, recommendedFiles (with relevanceTier), and key file contents — all within a configurable token budget. Pass excludePaths to skip already-read files. Use this instead of multiple separate read calls for a focused overview. Optionally pass a goal to filter to relevant files.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          goal: z.string().optional().describe("Optional: focus the pack on this goal or feature area"),
          maxTokens: z.number().optional().describe("Optional token budget (default 8000)"),
          excludePaths: z.array(z.string()).optional().describe("File paths already read — skip from results"),
          refresh: z.boolean().optional().describe("Force refresh cache (default false)"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("semantic_pack", req, await semanticPackTool(workspace.root, config.allowedRoots, { goal: req.goal, maxTokens: req.maxTokens, excludePaths: req.excludePaths, refresh: req.refresh }));
      }
    );

    registerAppTool(
      server,
      "context_budget",
      {
        title: "[ADVANCED] Context Budget",
        description: "[Context] Estimates token count for one or more files. Use this to decide which files to include or skip when context window is limited. Returns lines, characters, and estimated tokens per file.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          paths: z.array(z.string()).describe("File paths to estimate"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        return wrap("context_budget", req, await contextBudgetTool({ paths: req.paths }, workspace.root));
      }
    );

    registerAppTool(
      server,
      "expand_compressed_block",
      {
        title: "[ADVANCED] Expand Compressed Block",
        description: "[File System] Expand a previously compressed (omitted) block from a read_compressed result. When read_compressed returns omissions with 'mustExpandBeforeEdit: true', call this tool to fetch the full content for that block before making edits. Pass the file path and the omission's description (from the 'lines' field) to expand it.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          path: z.string().describe("File path to expand from"),
          block: z.string().describe("The omission description (lines field) to expand"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        const fsModule = await import("node:fs");
        const pathModule = await import("node:path");
        const fullPath = enforceSecurePath(req.path, workspace.root, [workspace.root], false);
        if (!fsModule.existsSync(fullPath)) {
          return { content: [{ type: "text", text: "File does not exist." }], isError: true };
        }
        const content = fsModule.readFileSync(fullPath, "utf8");
        const { expandOmittedBlock } = await import("./context-engine/compressors.js");
        const expanded = expandOmittedBlock(content, req.block);
        const text = JSON.stringify(expanded, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: { result: text },
        };
      }
    );

    registerAppTool(
      server,
      "token_audit",
      {
        title: "[ADVANCED] Token Audit",
        description: "[Context] Analyze token usage across all files read in the current turn. Returns which files consumed the most tokens, how much budget remains, and suggestions for reducing context bloat (use compression, skip non-essential files, etc).",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          files: z.array(z.object({
            path: z.string().describe("File path"),
            compressed: z.boolean().optional().describe("Whether this file was read via read_compressed"),
            level: z.enum(["none", "light", "balanced", "aggressive", "skeletal"]).optional().describe("Compression level used"),
            actualChars: z.number().optional().describe("Actual characters returned to the model (for compressed reads). If omitted, uses the file size on disk."),
          })).describe("List of files read in this turn"),
          maxBudget: z.number().optional().describe("Optional total token budget for recommendations"),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_TOOL_ANNOTATIONS,
      } as any,
      async (req: any) => {
        const workspace = workspaces.getWorkspace(req.workspaceId);
        const fsModule = await import("node:fs");
        const pathModule = await import("node:path");
        const budget = req.maxBudget ?? 64000;
        let totalTokens = 0;
        const breakdown: any[] = [];
        for (const file of req.files || []) {
          const fullPath = enforceSecurePath(file.path, workspace.root, [workspace.root], false);
          if (!fsModule.existsSync(fullPath)) {
            breakdown.push({ path: file.path, tokens: 0, error: "not found" });
            continue;
          }
          const charsPerToken = file.path.endsWith(".ts") || file.path.endsWith(".js") ? 4 : 6;
          // For compressed reads, use actualChars if provided; otherwise fall back to full file size
          const originalContent = fsModule.readFileSync(fullPath, "utf8");
          const originalTokens = Math.ceil(originalContent.length / charsPerToken);
          const actualChars = file.actualChars ?? originalContent.length;
          const actualTokens = Math.ceil(actualChars / charsPerToken);
          const tokens = actualTokens; // report what the model actually consumed
          totalTokens += tokens;
          
          // Contextual suggestions based on compression status
          let suggestions = null;
          if (file.compressed) {
            const savings = originalTokens - actualTokens;
            const pct = originalTokens > 0 ? Math.round((savings / originalTokens) * 100) : 0;
            // Try to determine if compression was effective by re-compressing
            let wasEffective = false;
            if (file.level && file.level !== "none") {
              try {
                const { compressAST } = await import("./context-engine/compressors.js");
                const result = compressAST(originalContent, file.level);
                wasEffective = result.metadata.compressionEffective;
              } catch {}
            }
            if (wasEffective === false) {
              suggestions = "Compression was ineffective for this file. Prefer payload_schema_map, next_route_map, or targeted read instead.";
            } else {
              suggestions = `Compressed: saved ${savings} tokens (${pct}% reduction). Good.`;
            }
          } else if (tokens > 8000) {
            suggestions = "Consider using read_compressed to reduce token load";
          }
          
          breakdown.push({
            path: file.path,
            tokens: actualTokens,
            originalTokens,
            ...(file.compressed ? { compressionSaved: originalTokens - actualTokens } : {}),
            chars: actualChars,
            originalChars: originalContent.length,
            compressed: file.compressed || false,
            suggestions
          });
        }
        const remaining = Math.max(0, budget - totalTokens);
        const recommendations: string[] = [];
        if (totalTokens > budget) { recommendations.push(`Over budget by ${totalTokens - budget} tokens. Consider reading only essential files.`); }
        if (totalTokens > budget * 0.8) { recommendations.push("Approaching budget limit. Use semantic_pack for a compact overview, then expand specific files."); }
        const text = JSON.stringify({ totalTokens, budget, remaining, breakdown, recommendations }, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: { result: text },
        };
      }
    );
  }

  if (true) {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode === "minimal"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : config.toolMode === "assistant"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, and complex shell interactions. Do not use ${toolNames.shell} for file inspection, discovery, git status/diff/log, or running package scripts; prefer the specialized tools (workspace_summary, tree, safe_file_preview, git_status, git_diff, git_log, run_package_script, read_many) for those read-only and targeted actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  }

// removed
// removed
// removed

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "Agentic MCP",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "agentic" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.stack : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closed = false;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      if (closed) return;
      closed = true;
      processSessions.shutdown();
      oauthProvider.close();
      workspaceStore.close?.();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `agentic listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  const shutdown = () => {
    httpServer.close(() => {
      close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}











