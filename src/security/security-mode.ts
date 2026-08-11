export type SecurityMode = "safe" | "trusted" | "full";

export const SECURITY_MODES: readonly SecurityMode[] = ["safe", "trusted", "full"];

export function parseSecurityMode(value: string | undefined): SecurityMode {
  if (!value || value === "safe") return "safe";
  if (value === "trusted" || value === "full") return value;
  throw new Error(`Invalid AGENTIC_SECURITY_MODE: ${value}. Use safe, trusted, or full.`);
}
