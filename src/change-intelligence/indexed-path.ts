import { basename, dirname } from "node:path";
import type { CandidateKind } from "./types.js";

export interface IndexedPath {
  path: string;
  base: string;
  dir: string;
  nameOnly: string;
  kind: CandidateKind;
}

const EVAL_DIR_PATTERNS = /[/\\](?:eval|evals|test-cases|fixtures)[/\\]/i;
const SNAPSHOT_EXT_PATTERN = /\.snap\.(?:ts|tsx|js|jsx|json)$/i;
const GENERATED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  ".terraform.lock.hcl", "Gemfile.lock",
]);
const CONFIG_EXT_PATTERNS = /\.(?:config\.(?:ts|js|json|mjs|cjs)|d\.ts)$/i;
const DOC_DIR_PATTERNS = /(?:^|[/\\])docs?(?:[/\\]|$)/i;
const BUILD_DIR_PATTERNS = /[/\\](?:dist|build|out|\.next|\.nuxt)[/\\]/i;

export function classifyCandidateKind(path: string): CandidateKind {
  const lower = path.toLowerCase().replace(/\\/g, "/");

  // Generated build artifacts
  if (BUILD_DIR_PATTERNS.test(lower)) return "generated";
  if (GENERATED_FILES.has(lower.split("/").pop() ?? "")) return "generated";

  // Evaluation test inputs/outputs
  if (EVAL_DIR_PATTERNS.test(lower)) return "evaluation";

  // Snapshots
  if (SNAPSHOT_EXT_PATTERN.test(lower)) return "snapshot";

  // Documentation
  if (DOC_DIR_PATTERNS.test(lower)) return "documentation";

  // Test files
  const base = lower.split("/").pop() ?? "";
  if (base.includes(".test.") || base.includes(".spec.") || lower.includes("/__tests__/")) return "test";

  // Configuration
  if (CONFIG_EXT_PATTERNS.test(lower)) return "configuration";
  if (base.startsWith("tsconfig")) return "configuration";
  if (base.startsWith("eslint")) return "configuration";
  if (base.startsWith(".env")) return "configuration";
  if (lower.endsWith("d.ts")) return "configuration";

  return "source";
}

export function createIndexedPath(path: string): IndexedPath {
  const base = basename(path);
  const dir = dirname(path);
  const dotIndex = base.lastIndexOf(".");
  const nameOnly = dotIndex !== -1 ? base.substring(0, dotIndex).toLowerCase() : base.toLowerCase();
  const kind = classifyCandidateKind(path);
  return { path, base, dir, nameOnly, kind };
}

/** Returns true if this CandidateKind is eligible for primary file role. */
export function isPrimaryEligibleKind(kind: CandidateKind): boolean {
  return kind === "source" || kind === "configuration" || kind === "unknown";
}

/** Returns true if this CandidateKind should be excluded from dependency analysis. */
export function isDependencySkippedKind(kind: CandidateKind): boolean {
  return kind === "evaluation" || kind === "snapshot" || kind === "generated" || kind === "documentation";
}
