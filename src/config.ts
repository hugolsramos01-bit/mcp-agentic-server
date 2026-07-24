import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { agenticAgentsDir, agenticSkillsDir, loadAgenticFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "assistant";
export type SpeedMode = "balanced" | "turbo";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  speedMode: SpeedMode;
  strictPvdl: boolean;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agenticSkillsDir: string;
  agenticAgentsDir: string;
  subagents: boolean;
  legacyAliases: boolean;
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.AGENTIC_TOOL_MODE;
  if (mode === "codex") throw new Error("Invalid AGENTIC_TOOL_MODE: codex. This mode was removed for security reasons. Use assistant, minimal, or full.");
  if (mode === "minimal" || mode === "full" || mode === "assistant") return mode;
  if (mode) throw new Error(`Invalid AGENTIC_TOOL_MODE: ${mode}`);

  if (env.AGENTIC_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.AGENTIC_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "assistant";
}

function parseSpeedMode(env: NodeJS.ProcessEnv): SpeedMode {
  const mode = env.AGENTIC_SPEED_MODE;
  if (mode === "turbo") return "turbo";
  return "balanced";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid AGENTIC_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid AGENTIC_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.AGENTIC_LOG_LEVEL),
    format: parseLogFormat(env.AGENTIC_LOG_FORMAT),
    requests: env.AGENTIC_LOG_REQUESTS === undefined ? true : parseBoolean(env.AGENTIC_LOG_REQUESTS),
    assets: parseBoolean(env.AGENTIC_LOG_ASSETS),
    toolCalls: env.AGENTIC_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.AGENTIC_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.AGENTIC_LOG_SHELL_COMMANDS),
    trustProxy: env.AGENTIC_TRUST_PROXY === undefined ? true : parseBoolean(env.AGENTIC_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "changes") return "changes";
  if (value === "off" || value === "full") return value;

  throw new Error(`Invalid AGENTIC_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for Agentic MCP OAuth. Run: agentic init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.AGENTIC_OAUTH_OWNER_TOKEN ?? ownerToken, "AGENTIC_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.AGENTIC_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "AGENTIC_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.AGENTIC_OAUTH_SCOPES, ["agentic"]),
    allowedRedirectHosts: parseStringList(env.AGENTIC_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "agentic");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".agentic", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadAgenticFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.AGENTIC_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.AGENTIC_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.AGENTIC_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env),
    speedMode: parseSpeedMode(env),
    strictPvdl: env.AGENTIC_STRICT_PVDL === undefined ? false : parseBoolean(env.AGENTIC_STRICT_PVDL),
    widgets: parseWidgetMode(env.AGENTIC_WIDGETS),
    stateDir: resolve(expandHomePath(env.AGENTIC_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.AGENTIC_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.AGENTIC_SKILLS === undefined ? true : parseBoolean(env.AGENTIC_SKILLS),
    skillPaths: parsePathList(env.AGENTIC_SKILL_PATHS),
    agenticSkillsDir: agenticSkillsDir(env),
    agenticAgentsDir: agenticAgentsDir(env),
    subagents:
      env.AGENTIC_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.AGENTIC_SUBAGENTS),
    legacyAliases: parseBoolean(env.AGENTIC_LEGACY_ALIASES),
    agentDir: resolve(expandHomePath(env.AGENTIC_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}


