export interface WorkspaceProcessEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  serverHost?: string;
  serverPort?: number;
  workspaceId?: string;
  workspaceRoot?: string;
  overrides?: NodeJS.ProcessEnv;
}

function definedEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
}

function consumedLegacyBinding(
  baseEnv: NodeJS.ProcessEnv,
  namespacedKey: "AGENTIC_HOST" | "AGENTIC_PORT",
  legacyKey: "HOST" | "PORT",
  consumedValue: string | undefined,
): boolean {
  if (baseEnv[namespacedKey] !== undefined) return false;
  if (baseEnv[legacyKey] === undefined || consumedValue === undefined) return false;
  return String(baseEnv[legacyKey]) === consumedValue;
}

/**
 * Build the environment exposed to commands that execute inside a user workspace.
 *
 * The Agentic server itself is configured from process.env, but workspace code must
 * not inherit Agentic control-plane credentials/configuration. Only explicitly
 * workspace-scoped Agentic variables are reintroduced after filtering.
 *
 * HOST/PORT are removed only when they were consumed as the server's legacy binding
 * variables. When AGENTIC_HOST/AGENTIC_PORT configure the server, generic HOST/PORT
 * remain available to the user's project.
 */
export function workspaceProcessEnvironment(
  options: WorkspaceProcessEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const baseEnv = options.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of definedEntries(baseEnv)) {
    if (key.startsWith("AGENTIC_")) continue;
    env[key] = value;
  }

  const serverHost = options.serverHost ?? baseEnv.AGENTIC_HOST;
  const serverPort = options.serverPort !== undefined
    ? String(options.serverPort)
    : baseEnv.AGENTIC_PORT;

  if (consumedLegacyBinding(baseEnv, "AGENTIC_HOST", "HOST", serverHost)) {
    delete env.HOST;
  }
  if (consumedLegacyBinding(baseEnv, "AGENTIC_PORT", "PORT", serverPort)) {
    delete env.PORT;
  }

  if (options.workspaceId) env.AGENTIC_WORKSPACE_ID = options.workspaceId;
  if (options.workspaceRoot) env.AGENTIC_WORKSPACE_ROOT = options.workspaceRoot;

  for (const [key, value] of definedEntries(options.overrides ?? {})) {
    env[key] = value;
  }

  return env;
}
