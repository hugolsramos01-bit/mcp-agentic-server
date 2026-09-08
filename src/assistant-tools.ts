import { assertCommandAllowed } from "./security/command-executor.js";
import { collectPackageScriptCommands } from "./security/script-resolver.js";
import { join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { enforceSecurePath, type ToolResponse } from "./pi-tools.js";
import { getWorkspaceGitEligibility } from "./git.js";
import type { SecurityMode } from "./security/security-mode.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceSummaryInput {}

export async function workspaceSummaryTool(cwd: string): Promise<ToolResponse> {
  const isGitRepo = existsSync(join(cwd, ".git"));
  let packageJson: any = null;
  
  try {
    const pkgContent = readFileSync(join(cwd, "package.json"), "utf8");
    packageJson = JSON.parse(pkgContent);
  } catch (e) {
    // Ignore
  }

  let topLevel: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    topLevel = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).slice(0, 50);
  } catch (e) {
    // Ignore
  }

  const summary = {
    root: cwd,
    isGitRepo,
    hasPackageJson: !!packageJson,
    name: packageJson?.name,
    version: packageJson?.version,
    scripts: packageJson?.scripts,
    dependencies: packageJson?.dependencies ? Object.keys(packageJson.dependencies) : [],
    devDependencies: packageJson?.devDependencies ? Object.keys(packageJson.devDependencies) : [],
    topLevel
  };

  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
  };
}

export type ReadManyOperation = "read" | "match" | "glob";

export interface ReadManyItem {
  path: string;
  operation?: ReadManyOperation;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  matchMode?: "regex" | "literal";
  caseSensitive?: boolean;
  beforeLines?: number;
  afterLines?: number;
  maxMatches?: number;
  include?: string;
  glob?: string;
  maxFiles?: number;
}

export interface ReadManyInput {
  paths?: string[];
  items?: ReadManyItem[];
  compressionLevel?: "none" | "light" | "balanced" | "aggressive" | "skeletal";
  maxTokens?: number;
  maxLines?: number;
  maxFiles?: number;
}

export type ReadManySkipCode =
  | "budget_exceeded"
  | "line_budget_exceeded"
  | "file_budget_exceeded"
  | "file_not_found"
  | "path_is_directory"
  | "permission_denied"
  | "invalid_range"
  | "invalid_item"
  | "invalid_pattern"
  | "resource_limit"
  | "path_resolution_failed"
  | "read_failed";

export interface ReadManySkippedItem {
  path: string;
  code: ReadManySkipCode;
  reason: string;
}

interface SafeReadFailure {
  code: ReadManySkipCode;
  reason: string;
}

function safeReadFailure(error: unknown): SafeReadFailure {
  const systemCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as any).code)
      : undefined;

  switch (systemCode) {
    case "ENOENT":
    case "ENOTDIR":
      return { code: "file_not_found", reason: "File was not found." };
    case "EISDIR":
      return { code: "path_is_directory", reason: "Requested path is a directory." };
    case "EACCES":
    case "EPERM":
      return { code: "permission_denied", reason: "Permission was denied." };
    case "AGENTIC_READ_MANY_RESOURCE_LIMIT":
      return {
        code: "resource_limit",
        reason: error instanceof Error ? error.message : "Composite read resource limit exceeded.",
      };
    default:
      return { code: "path_resolution_failed", reason: "Path could not be resolved safely." };
  }
}

const READ_MANY_DEFAULT_MAX_TOKENS = 12_000;
const READ_MANY_DEFAULT_MAX_LINES = 5_000;
const READ_MANY_DEFAULT_MAX_FILES = 100;
const READ_MANY_MAX_ITEMS = 100;
const READ_MANY_MAX_PATH_LENGTH = 4_096;
const READ_MANY_MAX_PATTERN_LENGTH = 500;
const READ_MANY_MAX_MATCHES = 200;
const READ_MANY_MAX_CONTEXT_LINES = 200;
const READ_MANY_MAX_SCAN_FILES = 10_000;
const READ_MANY_MAX_MATCH_FILE_BYTES = 2 * 1024 * 1024;
const READ_MANY_MAX_MATCH_SCAN_BYTES = 64 * 1024 * 1024;
const READ_MANY_MAX_READ_FILE_BYTES = 32 * 1024 * 1024;
const READ_MANY_MAX_LOADED_BYTES = 96 * 1024 * 1024;
const READ_MANY_MAX_REGEX_LINE_LENGTH = 32 * 1024;
const READ_MANY_MAX_SKIPPED_DETAILS = 50;
const READ_MANY_MAX_DIAGNOSTIC_STRING_LENGTH = 512;
const READ_MANY_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
]);

function normalizeWorkspacePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function workspaceRelativePath(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  return normalizeWorkspacePath(rel || ".");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source);
}

function validateBoundedRegexSource(pattern: string): string | null {
  if (/\\[1-9]/.test(pattern)) {
    return "regex backreferences are not supported because they can cause unbounded backtracking";
  }
  if (/\(\?<([=!])/.test(pattern)) {
    return "regex lookbehind is not supported in bounded match mode";
  }
  const quantifiedGroup = /\((?:\\.|[^()])*(?:[+*]|\{\d+(?:,\d*)?\}|\|)(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/;
  if (quantifiedGroup.test(pattern)) {
    return "regex contains a nested or ambiguous quantified group that may cause excessive backtracking";
  }
  return null;
}

function compileReadManyPattern(item: ReadManyItem): RegExp {
  const pattern = item.pattern ?? "";
  if (!pattern) throw new Error("match operation requires a non-empty pattern");
  if (pattern.length > READ_MANY_MAX_PATTERN_LENGTH) {
    throw new Error(`match pattern must be <= ${READ_MANY_MAX_PATTERN_LENGTH} characters`);
  }
  const flags = item.caseSensitive === false ? "i" : "";
  if ((item.matchMode ?? "literal") === "literal") {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }
  const unsafeReason = validateBoundedRegexSource(pattern);
  if (unsafeReason) throw new Error(unsafeReason);
  return new RegExp(pattern, flags);
}

function readManyOperation(item: ReadManyItem): ReadManyOperation {
  if (item.operation) return item.operation;
  if (item.pattern !== undefined) return "match";
  if (item.glob !== undefined) return "glob";
  return "read";
}

function validateReadManyItem(item: ReadManyItem): string | null {
  const operation = readManyOperation(item);
  if (item.path.length > READ_MANY_MAX_PATH_LENGTH) {
    return `path must be <= ${READ_MANY_MAX_PATH_LENGTH} characters`;
  }
  const hasStart = item.startLine !== undefined;
  const hasEnd = item.endLine !== undefined;
  const incompatible = (fields: Array<keyof ReadManyItem>): string | null => {
    const present = fields.filter((field) => item[field] !== undefined);
    return present.length > 0
      ? `${operation} operation cannot include ${present.join(", ")}`
      : null;
  };

  if (operation === "read") {
    const invalidFields = incompatible([
      "pattern", "matchMode", "caseSensitive", "beforeLines", "afterLines",
      "maxMatches", "include", "glob", "maxFiles",
    ]);
    if (invalidFields) return invalidFields;
    if (hasStart !== hasEnd) return "range requires both startLine and endLine";
    return null;
  }

  if (operation === "match") {
    const invalidFields = incompatible(["startLine", "endLine", "glob", "maxFiles"]);
    if (invalidFields) return invalidFields;
    if (!item.pattern) return "match operation requires a non-empty pattern";
    if (item.pattern.length > READ_MANY_MAX_PATTERN_LENGTH) {
      return `match pattern must be <= ${READ_MANY_MAX_PATTERN_LENGTH} characters`;
    }
    if (item.include !== undefined && item.include.length > READ_MANY_MAX_PATTERN_LENGTH) {
      return `match include glob must be <= ${READ_MANY_MAX_PATTERN_LENGTH} characters`;
    }
    if ((item.beforeLines ?? 0) < 0 || (item.afterLines ?? 0) < 0) {
      return "match context lines must be >= 0";
    }
    if ((item.beforeLines ?? 0) > READ_MANY_MAX_CONTEXT_LINES || (item.afterLines ?? 0) > READ_MANY_MAX_CONTEXT_LINES) {
      return `match context lines must be <= ${READ_MANY_MAX_CONTEXT_LINES}`;
    }
    if ((item.maxMatches ?? 20) <= 0 || (item.maxMatches ?? 20) > READ_MANY_MAX_MATCHES) {
      return `maxMatches must be between 1 and ${READ_MANY_MAX_MATCHES}`;
    }
    return null;
  }

  const invalidFields = incompatible([
    "startLine", "endLine", "pattern", "matchMode", "caseSensitive",
    "beforeLines", "afterLines", "maxMatches", "include",
  ]);
  if (invalidFields) return invalidFields;
  if (!item.glob) return "glob operation requires a non-empty glob";
  if (item.glob.length > READ_MANY_MAX_PATTERN_LENGTH) {
    return `glob must be <= ${READ_MANY_MAX_PATTERN_LENGTH} characters`;
  }
  if ((item.maxFiles ?? 50) <= 0) return "glob maxFiles must be >= 1";
  return null;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

interface ReadManyWorkspaceFileList {
  files: string[];
  truncated: boolean;
}

async function listReadManyWorkspaceFiles(cwd: string, scopeRel = "."): Promise<ReadManyWorkspaceFileList> {
  try {
    const args = ["ls-files", "-co", "--exclude-standard", "-z"];
    if (scopeRel !== ".") args.push("--", scopeRel);
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    } as any);
    const raw = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout);
    const allFiles = raw.split("\0").filter(Boolean);
    const files = allFiles.slice(0, READ_MANY_MAX_SCAN_FILES);
    return {
      files: files.map(normalizeWorkspacePath),
      truncated: allFiles.length > files.length,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as any).code)
      : "";
    const hasGitMetadata = existsSync(join(cwd, ".git"));
    if (hasGitMetadata || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { files: [], truncated: true };
    }
    // Recursive walk is only for workspaces that are genuinely non-Git.
  }

  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  let truncated = false;
  async function walk(fullDir: string): Promise<void> {
    if (files.length >= READ_MANY_MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(fullDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= READ_MANY_MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      if (entry.name === "." || entry.name === "..") continue;
      const fullPath = join(fullDir, entry.name);
      if (entry.isDirectory()) {
        if (!READ_MANY_IGNORED_DIRS.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(workspaceRelativePath(cwd, fullPath));
      }
    }
  }
  await walk(scopeRel === "." ? cwd : resolve(cwd, scopeRel));
  return { files, truncated };
}

interface ReadManyBudgetState {
  maxTokens: number;
  maxLines: number;
  maxFiles: number;
  usedTokens: number;
  usedLines: number;
  returnedFiles: Set<string>;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}

function budgetBlockReason(
  budget: ReadManyBudgetState,
  content: string,
  files: string[],
  serializedTokenCost = estimateTokens(content),
): { code: ReadManySkipCode; reason: string } | null {
  const newFiles = files.filter((path) => !budget.returnedFiles.has(path));
  if (budget.returnedFiles.size + new Set(newFiles).size > budget.maxFiles) {
    return {
      code: "file_budget_exceeded",
      reason: `exceeds remaining file budget of ${Math.max(0, budget.maxFiles - budget.returnedFiles.size)}`,
    };
  }
  const lines = lineCount(content);
  if (budget.usedLines + lines > budget.maxLines) {
    return {
      code: "line_budget_exceeded",
      reason: `exceeds remaining line budget of ${Math.max(0, budget.maxLines - budget.usedLines)} lines`,
    };
  }
  if (budget.usedTokens + serializedTokenCost > budget.maxTokens) {
    return {
      code: "budget_exceeded",
      reason: `exceeds remaining token budget of ~${Math.max(0, budget.maxTokens - budget.usedTokens)} tokens (estimated serialized cost ~${serializedTokenCost})`,
    };
  }
  return null;
}

function consumeBudget(
  budget: ReadManyBudgetState,
  content: string,
  files: string[],
  serializedTokenCost = estimateTokens(content),
): void {
  budget.usedTokens += serializedTokenCost;
  budget.usedLines += lineCount(content);
  for (const path of files) budget.returnedFiles.add(path);
}

interface MatchRegion {
  path: string;
  startLine: number;
  endLine: number;
  matchedLines: number[];
  content: string;
  contentHash: string;
}

function mergeMatchWindows(
  lineNumbers: number[],
  lineTotal: number,
  beforeLines: number,
  afterLines: number,
): Array<{ startLine: number; endLine: number; matchedLines: number[] }> {
  const windows = lineNumbers.map((line) => ({
    startLine: Math.max(1, line - beforeLines),
    endLine: Math.min(lineTotal, line + afterLines),
    matchedLines: [line],
  }));
  const merged: Array<{ startLine: number; endLine: number; matchedLines: number[] }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, window.endLine);
      previous.matchedLines.push(...window.matchedLines);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

export async function readManyTool(input: ReadManyInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const resultFiles: any[] = [];
  const matchResults: any[] = [];
  const globResults: any[] = [];
  const maxTokens = input.maxTokens ?? READ_MANY_DEFAULT_MAX_TOKENS;
  const maxLines = input.maxLines ?? READ_MANY_DEFAULT_MAX_LINES;
  const maxFiles = input.maxFiles ?? READ_MANY_DEFAULT_MAX_FILES;

  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || maxTokens > 64_000) {
    throw new Error("read_many maxTokens must be between 1 and 64000.");
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0 || maxLines > 20_000) {
    throw new Error("read_many maxLines must be an integer between 1 and 20000.");
  }
  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || maxFiles > 2_000) {
    throw new Error("read_many maxFiles must be an integer between 1 and 2000.");
  }

  if ((input.paths && input.items) || (!input.paths && !input.items)) {
    throw new Error("read_many requires exactly one of 'paths' or 'items'.");
  }
  if (input.paths && input.paths.length === 0) {
    throw new Error("read_many requires non-empty 'paths' array.");
  }
  if (input.items && input.items.length === 0) {
    throw new Error("read_many requires non-empty 'items' array.");
  }
  const rawItemCount = input.items?.length ?? input.paths?.length ?? 0;
  if (rawItemCount > READ_MANY_MAX_ITEMS) {
    throw new Error(`read_many accepts at most ${READ_MANY_MAX_ITEMS} items per call.`);
  }

  const items: ReadManyItem[] = input.items || (input.paths || []).map(p => ({ path: p, operation: "read" }));
  const itemCount = items.length;

  // Proactive bloat warning only applies to broad full-file reads. Match/glob
  // operations are already bounded and are intended to replace shell slicing.
  const broadReadCount = items.filter((item) =>
    readManyOperation(item) === "read"
    && item.startLine === undefined
    && item.endLine === undefined
  ).length;
  const bloatWarning =
    broadReadCount >= 5 && (!input.compressionLevel || input.compressionLevel === "none")
      ? `⚠️  CONTEXT BLOAT WARNING: ${broadReadCount} full files requested without compression. ` +
        `Prefer fewer exact ranges or set compressionLevel to 'light' or 'balanced'. ` +
        `Proceeding with shared token/line/file budget guards.\n\n`
      : "";

  const { statSync, readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");

  // ── Per-call file cache: one stat + read + hash per unique fullPath ──
  // Prevents multiple stats and reads when multiple regions of a file are requested.
  interface ResolvedFile {
    fullPath: string;
    sizeBytes: number;
    mtimeNs: number;
  }
  const resolvedFiles = new Map<string, ResolvedFile>();

  function resolveFile(item: ReadManyItem): ResolvedFile {
    const fullPath = enforceSecurePath(item.path, cwd, allowedRoots, false);
    let resolved = resolvedFiles.get(fullPath);
    if (!resolved) {
      const stat = statSync(fullPath);
      resolved = {
        fullPath,
        sizeBytes: stat.size,
        mtimeNs: Number(stat.mtimeMs) * 1_000_000,
      };
      resolvedFiles.set(fullPath, resolved);
    }
    return resolved;
  }

  interface CachedFile {
    rawBytes: Buffer;
    lines: string[];
    contentHash: string;
    sizeBytes: number;
    mtimeNs: number;
  }
  const loadedFiles = new Map<string, CachedFile>();
  let loadedBytes = 0;

  function resourceLimitError(message: string): Error {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = "AGENTIC_READ_MANY_RESOURCE_LIMIT";
    return error;
  }

  function loadFile(resolved: ResolvedFile): CachedFile {
    const existing = loadedFiles.get(resolved.fullPath);
    if (existing) return existing;
    if (resolved.sizeBytes > READ_MANY_MAX_READ_FILE_BYTES) {
      throw resourceLimitError(
        `File is too large for composite read (${resolved.sizeBytes} bytes; max ${READ_MANY_MAX_READ_FILE_BYTES}). Use a specialized reader or narrower source artifact.`,
      );
    }
    if (loadedBytes + resolved.sizeBytes > READ_MANY_MAX_LOADED_BYTES) {
      throw resourceLimitError(
        `Composite read would exceed the ${READ_MANY_MAX_LOADED_BYTES}-byte in-memory file budget. Split the inspection into smaller calls.`,
      );
    }
    const rawBytes = readFileSync(resolved.fullPath);
    const content = rawBytes.toString("utf8");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const contentHash = "sha256:" + createHash("sha256").update(rawBytes).digest("hex");
    const entry: CachedFile = {
      rawBytes,
      lines,
      contentHash,
      sizeBytes: resolved.sizeBytes,
      mtimeNs: resolved.mtimeNs,
    };
    loadedFiles.set(resolved.fullPath, entry);
    loadedBytes += resolved.sizeBytes;
    return entry;
  }

  const skipped: ReadManySkippedItem[] = [];
  const skipCounts: Partial<Record<ReadManySkipCode, number>> = {};
  const skippedDetailLimit = Math.max(
    1,
    Math.min(READ_MANY_MAX_SKIPPED_DETAILS, Math.floor(maxTokens / 200) || 1),
  );
  let skippedOmitted = 0;
  function compactDiagnosticString(value: string): string {
    if (value.length <= READ_MANY_MAX_DIAGNOSTIC_STRING_LENGTH) return value;
    const marker = "... [diagnostic truncated]";
    return `${value.slice(0, READ_MANY_MAX_DIAGNOSTIC_STRING_LENGTH - marker.length)}${marker}`;
  }
  function recordSkip(item: ReadManySkippedItem): void {
    skipCounts[item.code] = (skipCounts[item.code] ?? 0) + 1;
    if (skipped.length < skippedDetailLimit) {
      skipped[skipped.length] = {
        ...item,
        path: compactDiagnosticString(item.path),
        reason: compactDiagnosticString(item.reason),
      };
    } else {
      skippedOmitted += 1;
    }
  }

  const budget: ReadManyBudgetState = {
    maxTokens,
    maxLines,
    maxFiles,
    usedTokens: 0,
    usedLines: 0,
    returnedFiles: new Set<string>(),
  };
  const workspaceFilesCache = new Map<string, ReadManyWorkspaceFileList>();

  async function workspaceFiles(scopeRel = "."): Promise<ReadManyWorkspaceFileList> {
    const cached = workspaceFilesCache.get(scopeRel);
    if (cached) return cached;
    const listed = await listReadManyWorkspaceFiles(cwd, scopeRel);
    workspaceFilesCache.set(scopeRel, listed);
    return listed;
  }

  async function scopedFiles(itemPath: string): Promise<ReadManyWorkspaceFileList> {
    const fullScope = enforceSecurePath(itemPath, cwd, allowedRoots, false);
    const { statSync } = await import("node:fs");
    const stat = statSync(fullScope);
    if (stat.isFile()) return { files: [workspaceRelativePath(cwd, fullScope)], truncated: false };
    if (!stat.isDirectory()) return { files: [], truncated: false };
    const scopeRel = workspaceRelativePath(cwd, fullScope);
    const prefix = scopeRel === "." ? "" : `${scopeRel.replace(/\/$/, "")}/`;
    const listed = await workspaceFiles(scopeRel);
    return {
      files: listed.files.filter((path) => !prefix || path.startsWith(prefix)),
      truncated: listed.truncated,
    };
  }

  // For legacy paths-mode, preserve the old smallest-first behavior. Composite
  // items-mode always preserves caller order: order is explicit priority.
  let orderedItems = items;
  if (!input.items) {
    const sortable: Array<{ item: ReadManyItem; sizeBytes: number }> = [];
    for (const item of items) {
      const invalid = validateReadManyItem(item);
      if (invalid) {
        recordSkip({ path: item.path, code: invalid.includes("range") ? "invalid_range" : "invalid_item", reason: invalid });
        continue;
      }
      try {
        sortable.push({ item, sizeBytes: resolveFile(item).sizeBytes });
      } catch (error) {
        const failure = safeReadFailure(error);
        recordSkip({ path: item.path, ...failure });
      }
    }
    orderedItems = sortable.sort((a, b) => a.sizeBytes - b.sizeBytes).map((entry) => entry.item);
  }

  for (const item of orderedItems) {
    const p = item.path;
    const operation = readManyOperation(item);
    const invalid = validateReadManyItem(item);
    if (invalid) {
      recordSkip({ path: p, code: operation === "read" && invalid.includes("range") ? "invalid_range" : "invalid_item", reason: invalid });
      continue;
    }

    if (operation === "read") {
      try {
        const resolved = resolveFile(item);
        const cached = loadFile(resolved);
        const startLine = item.startLine;
        const endLine = item.endLine;
        const isRanged = startLine !== undefined && endLine !== undefined;

        if (isRanged) {
          const sl = startLine as number;
          const el = endLine as number;
          if (sl <= 0 || el <= 0) {
            recordSkip({ path: p, code: "invalid_range", reason: `range startLine/endLine must be >= 1 (got ${sl}..${el})` });
            continue;
          }
          if (sl > el) {
            recordSkip({ path: p, code: "invalid_range", reason: `startLine (${sl}) must be <= endLine (${el})` });
            continue;
          }
          if (sl > cached.lines.length) {
            recordSkip({ path: p, code: "invalid_range", reason: `startLine (${sl}) exceeds file length (${cached.lines.length} lines)` });
            continue;
          }
        }

        let content: string;
        if (isRanged) {
          content = cached.lines.slice((startLine as number) - 1, endLine as number).join("\n");
        } else if (input.compressionLevel && input.compressionLevel !== "none") {
          const { compressAST } = await import("./context-engine/compressors.js");
          const rawContent = cached.rawBytes.toString("utf8");
          const compressed = compressAST(rawContent, input.compressionLevel, undefined, {
            cacheKey: resolved.fullPath,
            displayPath: item.path,
            mtime: cached.mtimeNs / 1_000_000,
          });
          content = compressed.output;
        } else {
          content = cached.rawBytes.toString("utf8");
        }

        const relativePath = workspaceRelativePath(cwd, resolved.fullPath);
        const readResult = {
          operation: "read",
          path: p,
          contentHash: cached.contentHash,
          sizeBytes: cached.sizeBytes,
          mtimeNs: cached.mtimeNs,
          startLine: item.startLine,
          endLine: item.endLine,
          content,
        };
        const serializedTokenCost = estimateJsonTokens(readResult);
        const blocked = budgetBlockReason(budget, content, [relativePath], serializedTokenCost);
        if (blocked) {
          recordSkip({ path: p, ...blocked });
          continue;
        }
        consumeBudget(budget, content, [relativePath], serializedTokenCost);
        resultFiles.push(readResult);
      } catch (error) {
        const failure = safeReadFailure(error);
        recordSkip({ path: p, ...failure });
      }
      continue;
    }

    if (operation === "glob") {
      try {
        const scopeFull = enforceSecurePath(p, cwd, allowedRoots, false);
        const { statSync } = await import("node:fs");
        if (!statSync(scopeFull).isDirectory()) {
          recordSkip({ path: p, code: "invalid_item", reason: "Glob scope must be a directory." });
          continue;
        }
        const matcher = globToRegExp(item.glob as string);
        const globBaseResult = {
          operation: "glob",
          path: p,
          glob: item.glob,
          files: [] as string[],
          returned: 0,
          truncated: false,
          scanTruncated: false,
        };
        const globBaseTokenCost = estimateJsonTokens(globBaseResult);
        const globBaseBlocked = budgetBlockReason(budget, "", [], globBaseTokenCost);
        if (globBaseBlocked) {
          recordSkip({ path: p, ...globBaseBlocked });
          continue;
        }
        consumeBudget(budget, "", [], globBaseTokenCost);
        const scopeRel = workspaceRelativePath(cwd, scopeFull);
        const prefix = scopeRel === "." ? "" : `${scopeRel.replace(/\/$/, "")}/`;
        const perItemMax = Math.min(item.maxFiles ?? 50, maxFiles);
        const scoped = await scopedFiles(p);
        const allMatched = scoped.files
          .map((path) => prefix ? path.slice(prefix.length) : path)
          .filter((path) => matcher.test(path));
        const workspacePaths: string[] = [];
        let budgetTruncated = false;
        for (const matchedPath of allMatched.slice(0, perItemMax)) {
          const workspacePath = prefix ? `${prefix}${matchedPath}` : matchedPath;
          const serializedTokenCost = estimateJsonTokens(workspacePath);
          const blocked = budgetBlockReason(budget, workspacePath, [workspacePath], serializedTokenCost);
          if (blocked) {
            recordSkip({ path: `${p}:${workspacePath}`, ...blocked });
            budgetTruncated = true;
            break;
          }
          consumeBudget(budget, workspacePath, [workspacePath], serializedTokenCost);
          workspacePaths.push(workspacePath);
        }
        globResults.push({
          operation: "glob",
          path: p,
          glob: item.glob,
          files: workspacePaths,
          returned: workspacePaths.length,
          truncated: scoped.truncated || budgetTruncated || allMatched.length > workspacePaths.length,
          scanTruncated: scoped.truncated,
        });
      } catch (error) {
        const failure = safeReadFailure(error);
        recordSkip({ path: p, ...failure });
      }
      continue;
    }

    try {
      let matcher: RegExp;
      try {
        matcher = compileReadManyPattern(item);
      } catch (error) {
        recordSkip({ path: p, code: "invalid_pattern", reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      const beforeLines = item.beforeLines ?? 0;
      const afterLines = item.afterLines ?? 0;
      const maxMatchesPerItem = item.maxMatches ?? 20;
      const scopeFull = enforceSecurePath(p, cwd, allowedRoots, false);
      const { statSync } = await import("node:fs");
      const scopeIsFile = statSync(scopeFull).isFile();
      const matchBaseResult = {
        operation: "match",
        path: p,
        pattern: item.pattern,
        matchMode: item.matchMode ?? "literal",
        include: item.include,
        caseSensitive: item.caseSensitive !== false,
        beforeLines,
        afterLines,
        matchCount: 0,
        regions: [] as MatchRegion[],
        scannedFiles: 0,
        scannedBytes: 0,
        skippedBinaryFiles: 0,
        skippedLargeFiles: 0,
        skippedLongRegexLines: 0,
        truncated: false,
        scanTruncated: false,
      };
      const matchBaseTokenCost = estimateJsonTokens(matchBaseResult);
      const matchBaseBlocked = budgetBlockReason(budget, "", [], matchBaseTokenCost);
      if (matchBaseBlocked) {
        recordSkip({ path: p, ...matchBaseBlocked });
        continue;
      }
      consumeBudget(budget, "", [], matchBaseTokenCost);
      const scoped = await scopedFiles(p);
      const scopeRel = workspaceRelativePath(cwd, scopeFull);
      const scopePrefix = scopeRel === "." || scopeIsFile ? "" : `${scopeRel.replace(/\/$/, "")}/`;
      const includeMatcher = item.include ? globToRegExp(item.include) : null;
      const candidates = includeMatcher
        ? scoped.files.filter((candidate) => {
            const scopedCandidate = scopeIsFile
              ? (candidate.split("/").at(-1) ?? candidate)
              : scopePrefix && candidate.startsWith(scopePrefix)
                ? candidate.slice(scopePrefix.length)
                : candidate;
            return includeMatcher.test(scopedCandidate);
          })
        : scoped.files;
      let matchCount = 0;
      let scannedFiles = 0;
      let skippedBinaryFiles = 0;
      let skippedLargeFiles = 0;
      let skippedLongRegexLines = 0;
      let scannedBytes = 0;
      let truncated = scoped.truncated;
      let budgetStopped = false;
      const regions: MatchRegion[] = [];

      for (const candidate of candidates) {
        if (matchCount >= maxMatchesPerItem) {
          truncated = true;
          break;
        }
        if (scannedFiles >= READ_MANY_MAX_SCAN_FILES) {
          truncated = true;
          break;
        }
        scannedFiles += 1;
        let resolved: ResolvedFile;
        try {
          resolved = resolveFile({ path: candidate });
        } catch {
          continue;
        }
        if (resolved.sizeBytes > READ_MANY_MAX_MATCH_FILE_BYTES) {
          skippedLargeFiles += 1;
          continue;
        }
        if (scannedBytes + resolved.sizeBytes > READ_MANY_MAX_MATCH_SCAN_BYTES) {
          truncated = true;
          break;
        }
        scannedBytes += resolved.sizeBytes;
        const cached = loadFile(resolved);
        if (looksBinary(cached.rawBytes)) {
          skippedBinaryFiles += 1;
          continue;
        }

        const matchedLines: number[] = [];
        for (let lineIndex = 0; lineIndex < cached.lines.length; lineIndex += 1) {
          const line = cached.lines[lineIndex];
          if ((item.matchMode ?? "literal") === "regex" && line.length > READ_MANY_MAX_REGEX_LINE_LENGTH) {
            skippedLongRegexLines += 1;
            continue;
          }
          matcher.lastIndex = 0;
          if (!matcher.test(line)) continue;
          matchedLines.push(lineIndex + 1);
          matchCount += 1;
          if (matchCount >= maxMatchesPerItem) {
            truncated = true;
            break;
          }
        }
        if (matchedLines.length === 0) continue;

        const windows = mergeMatchWindows(matchedLines, cached.lines.length, beforeLines, afterLines);
        for (const window of windows) {
          const content = cached.lines.slice(window.startLine - 1, window.endLine).join("\n");
          const relativePath = workspaceRelativePath(cwd, resolved.fullPath);
          const region: MatchRegion = {
            path: relativePath,
            startLine: window.startLine,
            endLine: window.endLine,
            matchedLines: window.matchedLines,
            content,
            contentHash: cached.contentHash,
          };
          const serializedTokenCost = estimateJsonTokens(region);
          const blocked = budgetBlockReason(budget, content, [relativePath], serializedTokenCost);
          if (blocked) {
            recordSkip({ path: `${p}:${relativePath}`, ...blocked });
            truncated = true;
            budgetStopped = true;
            break;
          }
          consumeBudget(budget, content, [relativePath], serializedTokenCost);
          regions.push(region);
        }
        if (budgetStopped) break;
      }

      matchResults.push({
        operation: "match",
        path: p,
        pattern: item.pattern,
        matchMode: item.matchMode ?? "literal",
        include: item.include,
        caseSensitive: item.caseSensitive !== false,
        beforeLines,
        afterLines,
        matchCount,
        regions,
        scannedFiles,
        scannedBytes,
        skippedBinaryFiles,
        skippedLargeFiles,
        skippedLongRegexLines,
        truncated,
        scanTruncated: scoped.truncated,
      });
    } catch (error) {
      const failure = safeReadFailure(error);
      recordSkip({ path: p, ...failure });
    }
  }

  const hasResults = resultFiles.length > 0 || matchResults.length > 0 || globResults.length > 0;
  const budgetCodes = new Set<ReadManySkipCode>(["budget_exceeded", "line_budget_exceeded", "file_budget_exceeded"]);
  const totalSkipped = Object.values(skipCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  const hasHardFailures = Object.entries(skipCounts).some(([code, count]) => (count ?? 0) > 0 && !budgetCodes.has(code as ReadManySkipCode));
  const budgetOnlyExhaustion = !hasResults && totalSkipped > 0 && !hasHardFailures;
  const isError = !hasResults && hasHardFailures;

  const finalWarning = budgetOnlyExhaustion
    ? "budget_exhausted"
    : (bloatWarning ? bloatWarning.trim() : undefined);

  const responseData: any = {
    files: resultFiles,
    matches: matchResults,
    globs: globResults,
    skipped,
    skippedOmitted,
    skipCounts,
    budget: {
      maxTokens,
      usedTokens: budget.usedTokens,
      maxLines,
      usedLines: budget.usedLines,
      maxFiles,
      usedFiles: budget.returnedFiles.size,
      estimatedPayloadTokens: 0,
      envelopeOverheadTokens: 0,
    },
    warning: finalWarning,
  };
  const envelope = {
    status: isError ? "error" : "success",
    data: responseData,
    error: isError ? "read_many could not read any requested item" : null,
    diagnostics: isError
      ? [{
          code: "all_items_failed",
          requestedItems: items.length,
          skippedItems: totalSkipped,
        }]
      : budgetOnlyExhaustion
      ? [{
          code: "budget_exhausted",
          requestedItems: items.length,
          returnedItems: 0,
        }]
      : []
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const estimatedPayloadTokens = estimateJsonTokens(envelope);
    responseData.budget.estimatedPayloadTokens = estimatedPayloadTokens;
    responseData.budget.envelopeOverheadTokens = Math.max(0, estimatedPayloadTokens - budget.usedTokens);
  }

  return {
    isError: isError,
    content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
    structuredContent: envelope
  };
}

export interface SafeFilePreviewInput {
  paths: string[];
}

export async function safeFilePreviewTool(input: SafeFilePreviewInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const result: any[] = [];
  for (const p of input.paths) {
    try {
      const fullPath = enforceSecurePath(p, cwd, [cwd], false);
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split('\n');

      // Collect imports: handle multi-line import blocks (lines ending with { without closing })
      const imports: string[] = [];
      let buffer = "";
      let inBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!inBlock) {
          if (trimmed.startsWith('import ') || trimmed.match(/^const .+= require\(/)) {
            if (trimmed.includes('{') && !trimmed.includes('}') && !trimmed.endsWith(';')) {
              buffer = trimmed; // start multi-line block
              inBlock = true;
            } else {
              imports.push(trimmed);
            }
          }
        } else {
          buffer += " " + trimmed;
          if (trimmed.includes('}') || trimmed.endsWith(';')) {
            imports.push(buffer.replace(/\s+/g, ' ').trim());
            buffer = "";
            inBlock = false;
          }
        }
        if (imports.length >= 20) break;
      }

      const exports = lines
        .filter(l => l.trim().startsWith('export '))
        .slice(0, 20)
        .map(l => l.trim());

      result.push({
        path: p,
        approxLines: lines.length,
        importCount: imports.length,
        exportCount: exports.length,
        imports,
        exports,
      });
    } catch (e: any) {
      result.push({ path: p, error: e.message });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}

export interface GitToolInput {
  staged?: boolean;
  path?: string;
  maxCount?: number;
}

export async function gitTool(subCommand: string, input: GitToolInput, cwd: string): Promise<ToolResponse> {
  try {
    const eligibility = await getWorkspaceGitEligibility(cwd);
    if (!eligibility.ok) {
      return { content: [{ type: "text", text: `Git ${subCommand} unavailable: ${eligibility.message ?? "workspace is not a Git repository."}` }], isError: true };
    }
    const args: string[] = [subCommand];

    if (subCommand === "diff") {
      args.push("--ignore-cr-at-eol");
      if (input.staged) {
        args.push("--cached");
      }
    }
    if (subCommand === "log") {
      args.push("--no-color");
      if (input.maxCount) {
        args.push(`-n`, String(input.maxCount));
      } else {
        args.push("-n", "10");
      }
    }
    if (input.path) {
      args.push("--", input.path);
    }

    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
    const trimmed = output.trim();
    if (!trimmed) {
      if (subCommand === "diff") {
        return { content: [{ type: "text", text: "No tracked-file diff. There may be untracked files; use git_status or changed_files_summary to inspect." }] };
      }
      if (subCommand === "log") {
        return { content: [{ type: "text", text: "No commits found." }] };
      }
      return { content: [{ type: "text", text: "Success (no output)" }] };
    }
    return {
      content: [{ type: "text", text: trimmed }]
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: error.message || String(error) }],
      isError: true
    };
  }
}

export interface TreeToolInput {
  path?: string;
  depth?: number;
}

export async function treeTool(input: TreeToolInput, cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const targetPath = enforceSecurePath(input.path || ".", cwd, [cwd], false);
  const maxDepth = input.depth ?? 3;
  
  const lines: string[] = [];
  
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: targetPath });
    const isBloat = (f: string) => {
      const parts = f.split('/');
      if (parts.some(p => ['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '.turbo', 'logs', 'coverage'].includes(p))) return true;
      if (f.match(/\.(png|jpe?g|gif|svg|ico|webp|mp4|webm|wav|mp3|log|lock|pdf)$/i)) return true;
      return false;
    };
    const files = stdout.split(/\r?\n/).filter(Boolean).filter(f => !isBloat(f));
    if (files.length === 0) {
      throw new Error("No files tracked or fallback to walk");
    }
    
    const root: Record<string, any> = {};
    for (const file of files) {
      const parts = file.split('/');
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          current[part] = null;
        } else {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      }
    }
    
    function buildStr(node: Record<string, any>, prefix: string, currentDepth: number) {
      if (currentDepth > maxDepth || lines.length >= 500) return;
      
      const keys = Object.keys(node).sort((a,b) => {
        const aIsDir = node[a] !== null;
        const bIsDir = node[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });
      
      for (let i = 0; i < keys.length; i++) {
        if (lines.length >= 500) {
          lines.push(`${prefix}└── (truncated)`);
          return;
        }
        const key = keys[i];
        const isLast = i === keys.length - 1;
        const marker = isLast ? "└── " : "├── ";
        const isDir = node[key] !== null;
        
        lines.push(`${prefix}${marker}${key}${isDir ? '/' : ''}`);
        
        if (isDir) {
          const childPrefix = prefix + (isLast ? "    " : "│   ");
          buildStr(node[key], childPrefix, currentDepth + 1);
        }
      }
    }
    
    buildStr(root, "", 1);
    
    return {
      content: [{ type: "text", text: lines.join('\n') || "(empty)" }]
    };
    
  } catch {
    // Fallback to original walk
    async function walk(dir: string, currentDepth: number, prefix: string) {
      if (currentDepth > maxDepth || lines.length >= 500) return;
      
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      
      entries = entries.filter(e => !['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '.turbo', 'logs', 'coverage'].includes(e.name));
      
      for (let i = 0; i < entries.length; i++) {
        if (lines.length >= 500) {
          lines.push(`${prefix}└── (truncated)`);
          break;
        }
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const marker = isLast ? "└── " : "├── ";
        
        lines.push(`${prefix}${marker}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        
        if (entry.isDirectory()) {
          const nextPrefix = prefix + (isLast ? "    " : "│   ");
          await walk(join(dir, entry.name), currentDepth + 1, nextPrefix);
        }
      }
    }
    
    await walk(targetPath, 1, "");
    
    return {
      content: [{ type: "text", text: lines.join('\n') || "(empty)" }]
    };
  }
}

export interface RunScriptInput {
  script: string;
  outputMode?: "full" | "summary" | "diagnostic-summary";
  timeoutMs?: number;
}

export async function runScriptTool(input: RunScriptInput, cwd: string, securityMode: SecurityMode = "safe"): Promise<ToolResponse> {
  try {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) {
      return {
        content: [{ type: "text", text: `package.json not found in ${cwd}. Cannot run package scripts.` }],
        isError: true,
        structuredContent: { status: "invalid_configuration", cwd, message: "package.json not found" },
      };
    }
    const pkgText = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgText);
    const availableScripts = pkg.scripts ? Object.keys(pkg.scripts) : [];

    if (!pkg.scripts || !pkg.scripts[input.script]) {
      return {
        content: [{ type: "text", text: `Script "${input.script}" not found in package.json. Available scripts: ${availableScripts.join(', ') || 'none'}` }],
        isError: true,
        structuredContent: { status: "script_not_found", cwd, message: `Script "${input.script}" not found` },
      };
    }

    // Detect the actual package manager from lockfiles
    const packageManager = existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";
    const fullCommand = `${packageManager} run ${input.script}`;


    if (securityMode !== "full") {
      const commandsToValidate = collectPackageScriptCommands({
        packageJson: pkg,
        scriptName: input.script,
        maxDepth: 10,
      });

      for (const cmd of commandsToValidate) {
        await assertCommandAllowed({
          command: cmd,
          workspaceRoot: cwd,
          workingDirectory: cwd,
          source: "package-script",
          securityMode,
        });
      }
    }

    await assertCommandAllowed({
      command: fullCommand,
      workspaceRoot: cwd,
      workingDirectory: cwd,
      source: "bash",
      securityMode,
    });

    const { runProcess } = await import("./process-runner/index.js");
    const result = await runProcess(packageManager, ["run", input.script], { cwd, timeoutMs: (input as any).timeoutMs ?? 600_000 });
    
    let stdout = result.status === "success" || result.status === "command_failed" || result.status === "timeout" || result.status === "cancelled" ? result.stdout : "";
    let stderr = result.status === "success" || result.status === "command_failed" || result.status === "timeout" || result.status === "cancelled" ? result.stderr : (result as any).message || "";
    let exitCode = result.status === "success" ? 0 : (result.status === "command_failed" ? result.exitCode : -1);

    const duration = result.durationMs;
    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");

    if (input.outputMode === "diagnostic-summary") {
      const { compressLog } = await import("./diagnostics/log-compressor.js");
      const summary = compressLog(fullCommand, output, exitCode, undefined, cwd);
      
      // Resolve suggestedReads paths relative to cwd — vitest in monorepos emits
      // paths like "tests/smoke/file.test.ts" from apps/ subdirectory,
      // but read tool expects workspace-root-relative paths.
      const nextActions: any[] = [];
      if (summary.suggestedReads) {
        for (const sr of summary.suggestedReads) {
          let resolvedPath = resolve(cwd, sr.path);
          if (!existsSync(resolvedPath)) {
            // Monorepo fallback: search apps/*, packages/*, src/* subdirectories.
            for (const sub of ["apps", "packages", "src"]) {
              const subDir = join(cwd, sub);
              if (!existsSync(subDir)) continue;
              try {
                const entries = await readdir(subDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue;
                  const candidate = join(subDir, entry.name, sr.path);
                  if (existsSync(candidate)) {
                    resolvedPath = candidate;
                    break;
                  }
                }
              } catch {}
              if (existsSync(resolvedPath)) break;
            }
          }
          if (!existsSync(resolvedPath)) continue;

          // Always emit existing workspace-relative source paths. Framework internals
          // and unresolved/absolute paths cannot be used by the read tool safely.
          const { relative } = await import("node:path");
          const workspaceRelativePath = relative(cwd, resolvedPath).replace(/\\/g, "/");
          if (
            workspaceRelativePath === "" ||
            workspaceRelativePath === ".." ||
            workspaceRelativePath.startsWith("../") ||
            workspaceRelativePath.split("/").includes("node_modules")
          ) continue;
          nextActions.push({
            tool: "read",
            arguments: {
              path: workspaceRelativePath,
              startLine: sr.startLine ?? 1,
              endLine: sr.endLine ?? 50,
            },
            reason: resolvedPath !== sr.path
              ? `Diagnostic referenced ${sr.path} — resolved to ${workspaceRelativePath}`
              : `Suggested by diagnostic: ${summary.summary?.primaryError?.message || "error context"}`,
            priority: nextActions.length === 0 ? 1 : 2,
          });
        }
      }
      
      // Attach the detected package manager + nextActions to the structured summary
      const responsePayload: any = {
        packageManager,
        ...summary,
        status: result.status,
        durationMs: duration,
        nextActions
      };
      if (result.status === "timeout") {
        responsePayload.timeoutMs = (result as any).timeoutMs;
        responsePayload.terminationConfirmed = (result as any).termination?.confirmed ?? false;
      }
      return {
        isError: exitCode !== 0 || result.status !== "success",
        content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }]
      };
    }

    // 'summary' mode: compact output with command, status, duration, and last relevant lines
    if (input.outputMode === "summary") {
      const lines = output.split("\n").filter(Boolean);
      const tailCount = Math.min(20, lines.length);
      const tail = lines.slice(-tailCount);
      const isLong = lines.length > tailCount;
      
      const summaryPayload: any = {
        command: fullCommand,
        packageManager,
        status: result.status,
        exitCode,
        durationMs: duration,
        totalLines: lines.length,
        lastLines: isLong ? tail : undefined,
        output: isLong ? undefined : output.trim(),
      };
      if (result.status === "timeout") {
        summaryPayload.timeoutMs = (result as any).timeoutMs;
        summaryPayload.terminationConfirmed = (result as any).termination?.confirmed ?? false;
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(summaryPayload, null, 2)
        }],
        isError: result.status !== "success",
        structuredContent: result,
      };
    }

    if (result.status !== "success") {
       return {
         content: [{ type: "text", text: result.status === "timeout"
           ? `[timeout] Process exceeded ${(result as any).timeoutMs}ms; termination ${(result as any).termination?.confirmed ? "confirmed" : "requested"}.\n${output.trim()}`
           : result.status === "cancelled"
             ? `[cancelled] Process termination ${(result as any).termination?.confirmed ? "confirmed" : "requested"}.\n${output.trim()}`
             : result.status === "infrastructure_error" ? `[infrastructure_error] ${(result as any).message}` : output.trim() }],
         isError: true,
         structuredContent: result,
       };
    }

    return {
      content: [{ type: "text", text: output.trim() || "Success (no output)" }],
      structuredContent: result,
    };
  } catch (error: any) {
    const message = error.message || String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      structuredContent: {
        status: /not allowed|blocked by policy|policy/i.test(message) ? "policy_blocked" : "invalid_configuration",
        cwd,
        message,
      },
    };
  }
}
