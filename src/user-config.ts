import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface AgenticUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  subagents?: boolean;
}

export interface AgenticAuthConfig {
  ownerToken?: string;
}

export interface AgenticFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: AgenticUserConfig;
  auth: AgenticAuthConfig;
}

export function agenticConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.AGENTIC_CONFIG_DIR ?? join(homedir(), ".agentic")));
}

export function agenticConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agenticConfigDir(env), "config.json");
}

export function agenticAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agenticConfigDir(env), "auth.json");
}

export function agenticSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agenticConfigDir(env), "skills");
}

export function agenticAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agenticConfigDir(env), "agents");
}

export function loadAgenticFiles(env: NodeJS.ProcessEnv = process.env): AgenticFiles {
  const dir = agenticConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<AgenticUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<AgenticAuthConfig>(authPath) : {},
  };
}

export function writeAgenticConfig(
  config: AgenticUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = agenticConfigPath(env);
  mkdirSync(agenticConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeAgenticAuth(
  auth: AgenticAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = agenticAuthPath(env);
  mkdirSync(agenticConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ensureAgenticDefaultSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const targetPath = join(agenticSkillsDir(env), "subagent-delegation", "SKILL.md");
  if (existsSync(targetPath)) return [];

  const sourcePath = new URL("../skills/subagent-delegation/SKILL.md", import.meta.url);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), { mode: 0o644 });
  return [targetPath];
}

export function resolveSubagentsFlag(
  config: Pick<AgenticUserConfig, "subagents">,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (env.AGENTIC_SUBAGENTS === undefined) return config.subagents;
  return ["1", "true", "yes", "on"].includes(env.AGENTIC_SUBAGENTS.toLowerCase());
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}


