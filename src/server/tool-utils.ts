import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import type { ServerConfig, WidgetMode } from "../config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
} from "../logger.js";
import type { LocalAgentProviderAvailability } from "../local-agent-availability.js";

// ─── Types ────────────────────────────────────────────────────

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolWidgetKind =
  | "workspace" | "read" | "write" | "edit" | "search"
  | "directory" | "shell" | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: { resourceUri: string; visibility: ["model"] };
}
type EmptyToolDefinitionMeta = Record<string, unknown> & { "ui/resourceUri"?: string };
interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}
export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}
interface WorkspaceAppManifestEntry {
  file: string; css?: string[]; isEntry?: boolean;
}
type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;
interface DiffStats { additions: number; removals: number; }

// ─── Constants ────────────────────────────────────────────────

export const WORKSPACE_APP_URI = "ui://agentic/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

export const WRITE_TOOL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const EDIT_TOOL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const SHELL_TOOL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
export const READ_TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

// ─── Widget Helpers ──────────────────────────────────────────

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off": return false;
    case "changes": return kind === "workspace" || kind === "show_changes";
    case "full": return true;
  }
}

export function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };
  return { _meta: { ui: { resourceUri: WORKSPACE_APP_URI, visibility: ["model"] } } };
}

// ─── Server Instructions ─────────────────────────────────────

export function serverInstructions(config: ServerConfig): string {
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use Agentic MCP as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. If the user later mentions a different folder or project, call ${toolNames.openWorkspace} again with that new path. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const strictPvdlNote = config.strictPvdl && config.toolMode === "assistant"
    ? "STRICT PVDL MODE: propose_plan is REQUIRED before edit/write. You must call propose_plan with your goal and filesToChange before any file modification. edit_dry_run is strongly recommended after the plan."
    : "";

  const speedNote = config.speedMode === "turbo"
    ? "TURBO MODE — optimize for SPEED, not token cost:\n" +
      "• Read MULTIPLE files at once using read_many (batch up to 5-10 files per call)\n" +
      "• Use grep to find what you need instead of reading files line-by-line\n" +
      "• Prefer semantic_pack with a goal to get a compact overview in one call\n" +
      "• Batch multiple edits to the same file into one edit call\n" +
      "• Skip edit_dry_run for trivially obvious single-line changes\n" +
      "• Skip checkpoint_save for non-destructive changes (config-only, comments)\n" +
      "• Read up to 500 lines per read call instead of conservative limits\n" +
      "• Be concise in responses — deliver findings directly without verbose commentary"
    : "BALANCED MODE — optimize for safety and thoroughness.";
  const turboSpeedNote = config.speedMode === "turbo" ? speedNote + "\n\n" : "";

  const inspection = config.toolMode === "minimal"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : config.toolMode === "assistant"
    ? `Tools are organized by visibility:
[CORE] — Always use these first: open_workspace, project_bootstrap, semantic_pack, grep, read_adaptive (auto-compresses!), read, read_many, git_status, git_diff, propose_plan, edit_dry_run, checkpoint_save, edit, write, run_package_script, show_changes, file_dependencies, tree.
[ADVANCED] — Use when core tools are insufficient: tournament_*, knowledge_*, set_policy, reset_policy, token_audit, context_budget, payload_schema_map, next_route_map, monorepo_map, safe_file_preview, apply_patch.
[DEPRECATED] — Avoid; use the replacement instead (preview_edit→edit_dry_run, next_routes_summary→next_route_map, payload_collections_summary→payload_schema_map, check_recommendations→suggest_checks, git_changes_summary→changed_files_summary, workspace_summary→project_bootstrap).

Prefer read_adaptive over read for most cases — it automatically picks the right compression level. Use read only when you need explicit line range control. Use read_compressed only when you need explicit compression level. Use read_many to batch reads.

Prefer the core tools for all exploration, file inspection, and git tasks instead of using the shell. Use edit_dry_run before edit to preview changes without writing. Before risky edits, use checkpoint_save to snapshot your changes; use checkpoint_restore to revert.

Follow the PVDL flow for every change:
1. PLAN: Call propose_plan with your goal, files to change, risks, and verification steps.
2. VERIFY: Call edit_dry_run to preview the exact changes before writing.
3. DO: Call checkpoint_save then edit or write to apply changes.
4. LOG: Run suggested checks (suggest_checks) to verify correctness.
Do not edit files without first calling propose_plan and edit_dry_run. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const shellUsage = config.toolMode === "assistant"
    ? `and ${toolNames.shell} ONLY for tests, builds, and complex system interactions that the specialized tools cannot handle`
    : `and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell`;

  return `${turboSpeedNote}${strictPvdlNote ? strictPvdlNote + "\n\n" : ""}Use Agentic MCP as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that same folder.

IMPORTANT — switching between projects: If the user mentions a different folder, project, codebase, or repository, call ${toolNames.openWorkspace} again with the new path. Do not try to work on multiple projects through a single workspaceId. The user's first request tells you which project to open; if they later mention another, reopen.

${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, ${shellUsage}. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}

// ─── Agent Formatting ────────────────────────────────────────

export function formatVisibleAgent(agent: {
  name: string; provider: string; model?: string; thinking?: string;
  providerAvailable?: boolean; providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

export function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

// ─── Output Schemas ──────────────────────────────────────────

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return { result: z.string().describe("Model-readable result text for follow-up reasoning and plain MCP hosts."), ...extra };
}

export const workspaceSkillOutputSchema = z.object({ name: z.string(), description: z.string(), path: z.string() });
export const workspaceAgentsFileOutputSchema = z.object({ path: z.string(), content: z.string() });
export const workspaceLocalAgentOutputSchema = z.object({ name: z.string(), description: z.string(), provider: z.string(), model: z.string().optional(), thinking: z.string().optional(), providerAvailable: z.boolean().optional(), providerUnavailableReason: z.string().optional() });
export const workspaceLocalAgentProviderOutputSchema = z.object({ name: z.string(), available: z.boolean(), reason: z.string().optional() });
export const workspaceAvailableAgentsFileOutputSchema = z.object({ path: z.string() });
export const reviewFileOutputSchema = z.object({ path: z.string(), previousPath: z.string().optional(), type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]), additions: z.number(), removals: z.number() });
export const reviewSummaryOutputSchema = z.object({ files: z.number(), additions: z.number(), removals: z.number() });

// ─── JSON-RPC Error ──────────────────────────────────────────

export function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// ─── Request Logging ─────────────────────────────────────────

export function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return { ip: requestIp(req, config.logging.trustProxy), host: req.header("host"), userAgent: req.header("user-agent"), origin: req.header("origin"), referer: req.header("referer"), contentLength: req.header("content-length") };
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;
  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

export function logFailedToolResponse(config: ServerConfig, fields: Omit<ToolLogFields, "success" | "durationMs" | "error">, content: ToolContent[], startedAt: number): void {
  logToolCall(config, { ...fields, success: false, durationMs: Math.round(performance.now() - startedAt), error: toolErrorPreview(content) });
}

// ─── Content Helpers ─────────────────────────────────────────

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function contentText(content: ToolContent[]): string {
  return content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n");
}

export function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function textSummary(content: ToolContent[]): { lines: number; characters: number } {
  const text = contentText(content);
  return { lines: text.length === 0 ? 0 : text.split("\n").length, characters: text.length };
}

export function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.slice(0, -1).split("\n").length : content.split("\n").length;
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };
  let additions = 0, removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}

export function newFilePatch(path: string, content: string): string {
  const lines = content.length === 0 ? [] : content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..0000000", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 ${hunkRange} @@`, body].filter(Boolean).join("\n");
}

// ─── UI Helpers ──────────────────────────────────────────────

export function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
  if (!entry?.file) throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

export function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? []).map((s) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, s)}" />`).join("\n");
  return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Agentic MCP Workspace</title>\n    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>\n${stylesheets}\n  </head>\n  <body>\n    <main id="app" class="shell">\n      <section class="empty">Waiting for a tool result.</section>\n    </main>\n  </body>\n</html>`;
}

export function appCsp(config: ServerConfig): { resourceDomains: string[]; connectDomains: string[] } {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return { resourceDomains: [publicBaseUrl], connectDomains: [publicBaseUrl] };
}

export function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../../dist/ui", import.meta.url));
}

export function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

export async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map((p) => new URL(`../../dist/ui/${p}`, import.meta.url));
  for (const candidate of candidates) await access(candidate);
}
