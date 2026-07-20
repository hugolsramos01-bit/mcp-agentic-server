/**
 * import-resolver.ts
 *
 * A TypeScript-compiler-based import resolver for the Agentic MCP Server.
 * Uses ts.readConfigFile, parseJsonConfigFileContent and resolveModuleName
 * to correctly handle:
 *   - tsconfig extends chains
 *   - jsconfig.json and allowJs
 *   - baseUrl and paths aliases
 *   - moduleResolution: bundler/node16/nodenext
 *   - Implicit extensions (.ts, .tsx, .mts, .cts, .js, .jsx)
 *   - index.ts barrel resolution
 *   - Cycle detection and maxDepth/maxFiles guards
 *
 * Returns a ResolverResult with resolved/unresolved counts and confidence score.
 */

import { dirname, resolve, relative, join, extname, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import ts from "typescript";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedImport {
  /** The original specifier as written in the source file */
  specifier: string;
  /** Resolved absolute file path, or null if unresolved */
  resolvedPath: string | null;
  /** Relative path from workspace root, or null */
  resolvedRelative: string | null;
  /** Whether it resolved via a barrel (re-export index file) */
  viaBarre?: string;
  /** Whether this is an external npm package (not a local file) */
  external: boolean;
}

export interface FileDependencyNode {
  path: string;
  imports: ResolvedImport[];
  /** Files that import this file */
  importedBy: string[];
}

export interface ResolverResult {
  /** All files visited, keyed by relative path from workspace root */
  files: Map<string, FileDependencyNode>;
  /** Specifiers that could not be resolved to a local file */
  unresolvedImports: Array<{ from: string; specifier: string }>;
  /** Number of files with at least one resolved local import */
  resolvedCount: number;
  /** Number of unresolvable local specifiers */
  unresolvedCount: number;
  /** 0–1 confidence score */
  confidence: number;
  /** Coverage description */
  coverage: string;
  /** Whether any cycle was detected */
  hasCycles: boolean;
  /** Detected cycles (arrays of paths forming the cycle) */
  cycles: string[][];
  /** Metrics */
  metrics: {
    filesAnalyzed: number;
    elapsedMs: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export interface ResolverOptions {
  /** Maximum dependency traversal depth (default: 10) */
  maxDepth?: number;
  /** Maximum total files to analyze (default: 500) */
  maxFiles?: number;
  /** Whether to follow transitive dependencies (default: true) */
  transitive?: boolean;
  /** Root of the workspace (for security boundary checks) */
  workspaceRoot: string;
  /** Entry file(s) to start analysis from, relative to workspaceRoot */
  entryPoints: string[];
}

// ─── Compiler Options Cache ──────────────────────────────────────────────────

const _compilerOptionsCache = new Map<string, { options: ts.CompilerOptions; mtime: number }>();

function loadCompilerOptions(startDir: string, workspaceRoot: string): ts.CompilerOptions {
  let directory = resolve(startDir);
  const root = resolve(workspaceRoot);

  while (true) {
    // Try tsconfig.json first, then jsconfig.json
    for (const configFile of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = join(directory, configFile);
      if (existsSync(configPath)) {
        try {
          const mtime = statSync(configPath).mtimeMs;
          const cached = _compilerOptionsCache.get(configPath);
          if (cached && cached.mtime === mtime) return cached.options;

          const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
          if (rawConfig.error) break;

          // Recursively resolve "extends" by letting TS do it
          const parsed = ts.parseJsonConfigFileContent(
            rawConfig.config,
            ts.sys,
            dirname(configPath),
            undefined,
            configPath,
          );

          const options = parsed.options;
          _compilerOptionsCache.set(configPath, { options, mtime });
          return options;
        } catch {
          break;
        }
      }
    }

    // Stop at workspace root
    if (resolve(directory) === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // Sensible defaults for plain JS projects
  return {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}

// ─── Implicit Extension Resolution ──────────────────────────────────────────

const IMPLICIT_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
];

function resolveImplicitExtensions(basePath: string): string | null {
  // Direct match first
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;

  // Try each extension
  for (const ext of IMPLICIT_EXTENSIONS) {
    const p = basePath + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }

  // Try index.* in directory
  for (const ext of IMPLICIT_EXTENSIONS) {
    const p = join(basePath, `index${ext}`);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }

  return null;
}

// ─── Specifier Resolution ────────────────────────────────────────────────────

function resolveSpecifier(
  specifier: string,
  importerAbsPath: string,
  compilerOptions: ts.CompilerOptions,
  workspaceRoot: string,
): { resolved: string | null; external: boolean } {
  // External packages — never resolve
  if (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#")
  ) {
    // Could be a path alias — let TS resolver handle it
    const tsResult = ts.resolveModuleName(
      specifier,
      importerAbsPath,
      compilerOptions,
      ts.sys,
    ).resolvedModule;

    if (tsResult && !tsResult.isExternalLibraryImport) {
      const resolved = tsResult.resolvedFileName;
      // Sanity check: must be inside workspace root
      if (resolve(resolved).startsWith(resolve(workspaceRoot))) {
        return { resolved, external: false };
      }
    }
    return { resolved: null, external: true };
  }

  // Relative specifier — resolve relative to importer
  const base = resolve(dirname(importerAbsPath), specifier);

  // First try TS module resolution (handles paths, baseUrl, extensions)
  const tsResult = ts.resolveModuleName(
    specifier,
    importerAbsPath,
    compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (tsResult && !tsResult.isExternalLibraryImport) {
    const resolved = tsResult.resolvedFileName;
    if (resolve(resolved).startsWith(resolve(workspaceRoot))) {
      return { resolved, external: false };
    }
  }

  // Fallback: try implicit extensions manually
  const fallback = resolveImplicitExtensions(base);
  if (fallback && resolve(fallback).startsWith(resolve(workspaceRoot))) {
    return { resolved: fallback, external: false };
  }

  return { resolved: null, external: false };
}

// ─── Module Specifier Extraction ─────────────────────────────────────────────

function extractSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

// ─── Barrel Detection ────────────────────────────────────────────────────────

function isBarrelFile(filePath: string): boolean {
  return basename(filePath, extname(filePath)) === "index";
}

// ─── Core Graph Builder ───────────────────────────────────────────────────────

export async function buildDependencyGraph(options: ResolverOptions): Promise<ResolverResult> {
  const startTime = Date.now();
  const { workspaceRoot, entryPoints, maxDepth = 10, maxFiles = 500, transitive = true } = options;
  const rootAbs = resolve(workspaceRoot);

  const files = new Map<string, FileDependencyNode>();
  const unresolvedImports: Array<{ from: string; specifier: string }> = [];
  const cycles: string[][] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  // Visited set for cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();

  async function visit(absPath: string, depth: number, chain: string[]): Promise<void> {
    const relPath = relative(rootAbs, absPath).replace(/\\/g, "/");

    if (files.size >= maxFiles) return;
    if (depth > maxDepth) return;

    // Cycle detection — must come BEFORE the visited check so back-edges are caught
    if (visiting.has(absPath)) {
      const cycleStart = chain.indexOf(absPath);
      if (cycleStart !== -1) {
        cycles.push(chain.slice(cycleStart).map(p => relative(rootAbs, p).replace(/\\/g, "/")));
      }
      return;
    }

    if (visited.has(absPath)) return;

    visiting.add(absPath);

    let sourceText: string;
    try {
      sourceText = ts.sys.readFile(absPath) ?? "";
    } catch {
      visiting.delete(absPath);
      return;
    }

    const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true);
    const specifiers = extractSpecifiers(sourceFile);
    const compilerOptions = loadCompilerOptions(dirname(absPath), workspaceRoot);

    const resolvedImports: ResolvedImport[] = [];

    for (const specifier of specifiers) {
      const { resolved, external } = resolveSpecifier(specifier, absPath, compilerOptions, workspaceRoot);

      const resolvedRelative = resolved ? relative(rootAbs, resolved).replace(/\\/g, "/") : null;

      const entry: ResolvedImport = {
        specifier,
        resolvedPath: resolved,
        resolvedRelative,
        external,
      };

      // Check if resolved through a barrel
      if (resolved && isBarrelFile(resolved)) {
        entry.viaBarre = resolvedRelative ?? undefined;
      }

      resolvedImports.push(entry);

      if (!external && !resolved) {
        unresolvedImports.push({ from: relPath, specifier });
      }
    }

    // Initialise node
    if (!files.has(relPath)) {
      files.set(relPath, { path: relPath, imports: resolvedImports, importedBy: [] });
    }

    // Populate reverse edges
    for (const imp of resolvedImports) {
      if (!imp.external && imp.resolvedRelative) {
        const target = imp.resolvedRelative;
        const existing = files.get(target);
        if (existing) {
          if (!existing.importedBy.includes(relPath)) {
            existing.importedBy.push(relPath);
          }
        } else {
          files.set(target, { path: target, imports: [], importedBy: [relPath] });
        }
      }
    }

    // Mark as fully visited BEFORE recursing, so children can detect the cycle back to us
    // We keep it in `visiting` throughout child traversal to detect back-edges
    visited.add(absPath);

    // Recurse transitively
    if (transitive) {
      for (const imp of resolvedImports) {
        if (!imp.external && imp.resolvedPath) {
          await visit(imp.resolvedPath, depth + 1, [...chain, absPath]);
        }
      }
    }

    // Only remove from visiting after all subtree is done
    visiting.delete(absPath);
  }

  for (const entry of entryPoints) {
    const abs = resolve(rootAbs, entry);
    if (!existsSync(abs)) continue;
    await visit(abs, 0, []);
  }

  // Compute metrics
  const resolvedCount = Array.from(files.values()).filter(n => n.imports.some(i => !i.external && i.resolvedPath !== null)).length;
  const unresolvedCount = unresolvedImports.length;
  const totalSpecifiers = Array.from(files.values()).reduce((sum, n) => sum + n.imports.filter(i => !i.external).length, 0);
  const confidence = totalSpecifiers === 0 ? 1 : Math.max(0, 1 - unresolvedCount / totalSpecifiers);

  return {
    files,
    unresolvedImports,
    resolvedCount,
    unresolvedCount,
    confidence: parseFloat(confidence.toFixed(3)),
    coverage: `${files.size} files analyzed; ${resolvedCount} with resolved local imports; ${unresolvedCount} unresolvable local specifiers`,
    hasCycles: cycles.length > 0,
    cycles,
    metrics: {
      filesAnalyzed: files.size,
      elapsedMs: Date.now() - startTime,
      cacheHits,
      cacheMisses,
    },
  };
}

// ─── Convenience: single-file inward/outward lookup ──────────────────────────

export interface SingleFileDepsOptions {
  workspaceRoot: string;
  targetRelPath: string;
  /** Files to consider as potential importers (from git ls-files) */
  allTrackedFiles: string[];
  transitiveDepth?: number;
  maxFiles?: number;
}

export interface SingleFileDepsResult {
  target: string;
  outwardDirect: ResolvedImport[];
  inwardDirect: string[];
  transitiveOutward: string[];
  unresolvedSpecifiers: string[];
  confidence: number;
  coverage: string;
  hasCycles: boolean;
  metrics: {
    filesAnalyzed: number;
    elapsedMs: number;
  };
}

export async function resolveFileDependencies(opts: SingleFileDepsOptions): Promise<SingleFileDepsResult> {
  const { workspaceRoot, targetRelPath, allTrackedFiles, transitiveDepth = 3, maxFiles = 300 } = opts;
  const rootAbs = resolve(workspaceRoot);
  const targetAbs = resolve(rootAbs, targetRelPath);

  // --- Outward: build graph from target ---
  const outwardGraph = await buildDependencyGraph({
    workspaceRoot,
    entryPoints: [targetRelPath],
    maxDepth: transitiveDepth,
    maxFiles,
    transitive: true,
  });

  const targetNode = outwardGraph.files.get(targetRelPath.replace(/\\/g, "/"));
  const outwardDirect = targetNode?.imports ?? [];
  const transitiveOutward = Array.from(outwardGraph.files.keys()).filter(k => k !== targetRelPath.replace(/\\/g, "/"));

  // --- Inward: scan tracked files for any that import the target ---
  const startInward = Date.now();
  const inwardDirect: string[] = [];
  const targetIdentity = moduleIdentity(targetRelPath);
  const compilerOptions = loadCompilerOptions(dirname(targetAbs), workspaceRoot);

  for (const file of allTrackedFiles) {
    if (moduleIdentity(file) === targetIdentity) continue;
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(file)) continue;

    const absFile = resolve(rootAbs, file);
    let text: string;
    try {
      text = ts.sys.readFile(absFile) ?? "";
    } catch {
      continue;
    }

    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const specifiers = extractSpecifiers(sf);

    for (const specifier of specifiers) {
      const { resolved } = resolveSpecifier(specifier, absFile, compilerOptions, workspaceRoot);
      if (resolved) {
        const resolvedRel = relative(rootAbs, resolved).replace(/\\/g, "/");
        if (moduleIdentity(resolvedRel) === targetIdentity) {
          inwardDirect.push(file.replace(/\\/g, "/"));
          break;
        }
      } else if (specifier.startsWith(".")) {
        // Lightweight fallback for relative without extension
        const candidate = moduleIdentity(join(dirname(file), specifier));
        if (candidate === targetIdentity) {
          inwardDirect.push(file.replace(/\\/g, "/"));
          break;
        }
      }
    }
  }

  return {
    target: targetRelPath.replace(/\\/g, "/"),
    outwardDirect,
    inwardDirect,
    transitiveOutward,
    unresolvedSpecifiers: outwardGraph.unresolvedImports.map(u => u.specifier),
    confidence: outwardGraph.confidence,
    coverage: outwardGraph.coverage,
    hasCycles: outwardGraph.hasCycles,
    metrics: {
      filesAnalyzed: outwardGraph.metrics.filesAnalyzed + allTrackedFiles.length,
      elapsedMs: outwardGraph.metrics.elapsedMs + (Date.now() - startInward),
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function moduleIdentity(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.replace(/\.(?:[cm]?[jt]sx?)$/i, "").replace(/\/index$/, "");
}
