import type { ToolResponse } from "./pi-tools.js";

// ─── Policy Types ────────────────────────────────────────────

/**
 * Action level for a policy rule:
 * - `block`: Always blocked, cannot be overridden.
 * - `dangerous`: Blocked by default; the model may ask the user for explicit
 *   confirmation to proceed. Only proceeds if the user explicitly confirms.
 * - `warn`: Proceeds, but the model MUST notify the user about the risk
 *   before executing. The model should include the warning in its response.
 * - `allow`: Proceeds without restriction.
 */
export type PolicyAction = "block" | "dangerous" | "warn" | "allow";

export interface PolicyRule {
  pattern: RegExp;
  reason: string;
  action: PolicyAction;
  scope?: "bash" | "all";
}

export type PolicyConfig = PolicyRule[];

// ─── Default Policy ──────────────────────────────────────────

const DEFAULT_POLICY: PolicyConfig = [
  // BLOCK — always blocked, cannot be overridden
  { pattern: /\brm\s+-rf\b/, reason: "Recursive force delete is destructive", action: "block", scope: "bash" },
  { pattern: /\bmkfs\b/, reason: "Filesystem creation is destructive", action: "block", scope: "bash" },
  { pattern: /\bdd\s+if=\/dev\/zero\b/, reason: "Zeroing blocks is destructive", action: "block", scope: "bash" },
  { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions are a security risk", action: "block", scope: "bash" },
  { pattern: /\bmv\s+\/dev\b/, reason: "Moving device files is destructive", action: "block", scope: "bash" },

  // DANGEROUS — requires explicit user confirmation
  { pattern: /\bgit\s+push\s+--force\b/, reason: "Force push rewrites remote history", action: "dangerous", scope: "bash" },
  { pattern: /\bgit\s+reset\s+--hard\s+HEAD\b/, reason: "Hard reset discards uncommitted changes permanently", action: "dangerous", scope: "bash" },
  { pattern: /\bdrop\s+table\b/i, reason: "DROP TABLE destroys database data permanently", action: "dangerous", scope: "bash" },
  { pattern: /\bdelete\s+from\b/i, reason: "DELETE FROM removes database rows permanently", action: "dangerous", scope: "bash" },

  // WARN — model must notify user about the risk
  { pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|add|link)\b/, reason: "Package installs should only run inside a worktree", action: "warn", scope: "bash" },
  { pattern: /\bgit\s+push\b/, reason: "Git push modifies remote; use with caution", action: "warn", scope: "bash" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "Hard reset discards uncommitted changes", action: "warn", scope: "bash" },
  { pattern: /\bgit\s+checkout\s+-{2,}/, reason: "Force checkout may discard local changes", action: "warn", scope: "bash" },
  { pattern: /\b(?:curl|wget)\s+.*\|?\s*(?:bash|sh|zsh)\b/, reason: "Piping web content to a shell is a security risk", action: "warn", scope: "bash" },
  { pattern: /\bsudo\b/, reason: "Running commands with sudo escalates privileges", action: "warn", scope: "bash" },

  // BLOCK FILE WRITING VIA SHELL — enforce the "don't use bash to write files" rule
  { pattern: />>?\s+/, reason: "Shell redirect writes to files; use write/edit tools instead", action: "block", scope: "bash" },
  { pattern: /\btee\b/, reason: "tee writes to files; use write/edit tools instead", action: "block", scope: "bash" },
  { pattern: /\bsed\s+-i\b/, reason: "sed -i modifies files in-place; use edit instead", action: "block", scope: "bash" },
  { pattern: /\bSet-Content\b/i, reason: "Set-Content writes files via PowerShell; use write/edit instead", action: "block", scope: "bash" },
  { pattern: /\bOut-File\b/i, reason: "Out-File writes files via PowerShell; use write/edit instead", action: "block", scope: "bash" },
  { pattern: /\bAdd-Content\b/i, reason: "Add-Content appends files via PowerShell; use write/edit instead", action: "block", scope: "bash" },
  { pattern: /\bnode\s+-e\s+["']/, reason: "node -e can execute arbitrary code including file writes; use write/edit instead", action: "block", scope: "bash" },
  { pattern: /\bpython\s+-c\s+["']/, reason: "python -c can execute arbitrary code including file writes; use write/edit instead", action: "block", scope: "bash" },
  { pattern: /<<\s*[-]?/, reason: "Here-documents write to files; use write/edit instead", action: "block", scope: "bash" },

  // Windows-specific destructive commands
  { pattern: /\bgit\s+clean\s+-[fd]/, reason: "git clean -fd removes all untracked files permanently", action: "dangerous", scope: "bash" },
  { pattern: /\bgit\s+clean\s+-ff?d?x?\b/, reason: "git clean -ffdx removes all untracked AND ignored files", action: "dangerous", scope: "bash" },
  { pattern: /\brmdir\s+\/s\s+\/q\b/i, reason: "rmdir /s /q recursively deletes directories on Windows", action: "block", scope: "bash" },
  { pattern: /\bRemove-Item\s+-Recurse\s+-Force\b/i, reason: "PowerShell Remove-Item -Recurse deletes files recursively", action: "block", scope: "bash" },
  { pattern: /\brm\s+-rf\s+(?:\/|\*|\.\*)/, reason: "Broad recursive delete from root or wildcard", action: "block", scope: "bash" },
];

// ─── In-Memory Policy Store ─────────────────────────────────

let activePolicy: PolicyConfig = [...DEFAULT_POLICY];



export function getPolicy(): PolicyConfig {
  return activePolicy;
}

// ─── Risk Assessment ─────────────────────────────────────────

export interface RiskAssessment {
  command: string;
  verdict: "allow" | "warn" | "dangerous" | "block";
  warnings: { rule: string; reason: string }[];
  dangerous: { rule: string; reason: string }[];
  blocked: { rule: string; reason: string }[];
  needsUserConfirmation: boolean;
}

export function assessCommand(command: string, scope: "bash" | "all" = "bash"): RiskAssessment {
  const warnings: { rule: string; reason: string }[] = [];
  const dangerous: { rule: string; reason: string }[] = [];
  const blocked: { rule: string; reason: string }[] = [];

  for (const rule of activePolicy) {
    if (rule.scope && rule.scope !== scope && rule.scope !== "all") continue;

    if (rule.pattern.test(command)) {
      const entry = { rule: rule.pattern.source, reason: rule.reason };
      if (rule.action === "block") {
        blocked.push(entry);
      } else if (rule.action === "dangerous") {
        dangerous.push(entry);
      } else if (rule.action === "warn") {
        warnings.push(entry);
      }
    }
  }

  let verdict: "allow" | "warn" | "dangerous" | "block" = "allow";
  let needsUserConfirmation = false;
  if (blocked.length > 0) verdict = "block";
  else if (dangerous.length > 0) { verdict = "dangerous"; needsUserConfirmation = true; }
  else if (warnings.length > 0) verdict = "warn";

  return { command, verdict, warnings, dangerous, blocked, needsUserConfirmation };
}

// ─── Tools ───────────────────────────────────────────────────






