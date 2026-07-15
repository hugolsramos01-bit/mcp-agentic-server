import { assessCommand } from "../policy-tools.js";
import { resolveWorkspacePath } from "./path-resolution.js";
import { AccessDeniedError } from "../roots.js";
import { join } from "node:path";

export interface CommandExecutionOptions {
  command: string;
  workspaceRoot: string;
  workingDirectory?: string;
  source: "bash" | "package-script" | "tournament" | "dependency-install";
}

/**
 * Validates a command against the security policy before execution.
 * Throws an error if the command is blocked or dangerous.
 */
export async function assertCommandAllowed(options: CommandExecutionOptions): Promise<void> {
  const { command, workspaceRoot, workingDirectory, source } = options;

  // 1. Enforce working directory confinement
  if (workingDirectory) {
    // resolveWorkspacePath will throw if the directory is outside the workspace
    const { exists } = resolveWorkspacePath(workspaceRoot, workingDirectory, false);
    if (!exists) {
       throw new AccessDeniedError(`Working directory does not exist or escapes workspace: ${workingDirectory}`);
    }
  }

  // 2. Prevent interactive shells directly if needed
  const cmdTokens = command.trim().split(/\s+/);
  const baseCmd = cmdTokens[0].toLowerCase();
  
  if (['sh', 'bash', 'cmd', 'powershell', 'pwsh', 'zsh', 'python', 'node', 'ruby', 'perl'].includes(baseCmd)) {
    // If they just launch \`bash\` or \`python\` interactively without args, block it.
    if (cmdTokens.length === 1 || (cmdTokens.length === 2 && cmdTokens[1] === "-i")) {
       throw new AccessDeniedError(`Interactive interpreters are blocked for security reasons. Please pass a script or use -c.`);
    }
  }

  // 3. Evaluate the command against regex policies
  const assessment = await assessCommand(command);
  if (assessment.verdict === "block") {
    throw new AccessDeniedError(`Command blocked by security policy: ${assessment.blocked[0]?.reason || "blocked"}`);
  }
  
  if (assessment.verdict === "dangerous") {
    // We no longer support interactive confirmations for dangerous commands. Block them.
    throw new AccessDeniedError(`Command considered dangerous and is permanently blocked: ${assessment.dangerous[0]?.reason || "dangerous"}`);
  }

  // If verdict is "warn", we allow it to execute. The logs will capture the warning.
}
