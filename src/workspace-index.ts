// ─── WorkspaceIndex ──────────────────────────────────────────
// A lazily-loaded, shareable index of workspace metadata.
// Tools like coding_context and semantic_pack use this instead
// of rediscovering the same information independently.
//
// Populated on first call to projectBootstrapTool or codingContextTool.
// Subsequent calls read from cache unless forceRefresh=true.

import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { treeTool } from "./assistant-tools.js";
import { nextRouteMapTool, payloadSchemaMapTool } from "./ast-tools.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceCapabilities {
  git: boolean;
  node: true;
  monorepo: boolean;
  nextjs: boolean;
  payload: boolean;
  react: boolean;
  python: boolean;
  typescript: boolean;
  vitest: boolean;
}

export interface WorkspaceBootstrap {
  root: string;
  projectRoot: string;
  packageManager: string;
  isGitRepo: boolean;
  gitStatus: string;
  hasPackageJson: boolean;
  name?: string;
  scripts?: Record<string, string>;
  hasPnpmWorkspace: boolean;
  hasTurboJson: boolean;
  capabilities: WorkspaceCapabilities;
  instructions: string[];
}

export interface WorkspaceIndex {
  bootstrap: WorkspaceBootstrap;
  monorepo: any;
  routes: any[];
  collections: any[];
  indexedAt: number;
}

// Per-workspace cache — not persisted, ephemeral.
const indexCache = new Map<string, WorkspaceIndex>();

export function getCachedIndex(workspaceId: string): WorkspaceIndex | undefined {
  return indexCache.get(workspaceId);
}

export function invalidateIndex(workspaceId: string): void {
  indexCache.delete(workspaceId);
}

export async function buildWorkspaceIndex(
  workspaceId: string,
  cwd: string,
  allowedRoots: string[],
  forceRefresh = false,
): Promise<WorkspaceIndex> {
  if (!forceRefresh) {
    const cached = indexCache.get(workspaceId);
    if (cached) return cached;
  }

  // ─── Bootstrap ────────────────────────────────────────────
  const isGitRepo = existsSync(join(cwd, ".git"));
  let packageJson: any = null;
  try { packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); } catch {}

  let deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  let allDeps = Object.keys(deps);

  let pnpmWorkspace = false;
  let turboJson: any = null;
  try {
    if (existsSync(join(cwd, "pnpm-workspace.yaml"))) pnpmWorkspace = true;
    if (existsSync(join(cwd, "turbo.json"))) turboJson = JSON.parse(readFileSync(join(cwd, "turbo.json"), "utf8"));
  } catch {}

  // Monorepo capability aggregation: scan apps/* and packages/* for dependencies
  // to detect capabilities that exist only in sub-packages (e.g. next in apps/web)
  const aggregatedDeps = new Set(allDeps);
  const capabilityOrigins: Record<string, string[]> = {};
  const subDirs = [];
  try { if (existsSync(join(cwd, "apps"))) subDirs.push(...(await readdir(join(cwd, "apps"), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(cwd, "apps", d.name))); } catch {}
  try { if (existsSync(join(cwd, "packages"))) subDirs.push(...(await readdir(join(cwd, "packages"), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(cwd, "packages", d.name))); } catch {}
  for (const subDir of subDirs) {
    try {
      const subPkg = JSON.parse(readFileSync(join(subDir, "package.json"), "utf8"));
      const subDeps = { ...(subPkg.dependencies || {}), ...(subPkg.devDependencies || {}) };
      for (const d of Object.keys(subDeps)) {
        aggregatedDeps.add(d);
        if (!capabilityOrigins[d]) capabilityOrigins[d] = [];
        if (!capabilityOrigins[d].includes(subPkg.name || subDir.split("/").pop()!)) {
          capabilityOrigins[d].push(subPkg.name || subDir.split("/").pop()!);
        }
      }
    } catch {}
  }
  allDeps = [...aggregatedDeps];

  const capabilities: WorkspaceCapabilities = {
    git: isGitRepo,
    node: true,
    monorepo: !!pnpmWorkspace || existsSync(join(cwd, "apps")),
    nextjs: allDeps.some(d => d === "next" || d.startsWith("next-")),
    payload: allDeps.some(d => d.startsWith("@payloadcms/") || d === "payload"),
    react: allDeps.some(d => d === "react" || d === "react-dom"),
    python: existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py")),
    typescript: allDeps.some(d => d === "typescript") || existsSync(join(cwd, "tsconfig.json")) || (existsSync(join(cwd, "apps")) && readdirSync(join(cwd, "apps"), { withFileTypes: true }).some(d => d.isDirectory() && existsSync(join(cwd, "apps", d.name, "tsconfig.json")))),
    vitest: allDeps.some(d => d === "vitest" || d.startsWith("@vitest/")),
  };

  let gitStatus = "";
  if (isGitRepo) {
    try { const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], { cwd }); gitStatus = stdout; } catch {}
  }

  let instructions: string[] = [];
  try {
    const files = await readdir(cwd);
    for (const file of files.filter(f => f.toLowerCase().includes("readme") || f.toLowerCase().includes("instruction"))) {
      instructions.push(`--- ${file} ---\n${readFileSync(join(cwd, file), "utf8").substring(0, 1000)}...`);
    }
  } catch {}

  const bootstrap: WorkspaceBootstrap = {
    root: cwd,
    projectRoot: cwd,
    packageManager: existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(cwd, "yarn.lock")) ? "yarn" : "npm",
    isGitRepo,
    gitStatus,
    hasPackageJson: !!packageJson,
    name: packageJson?.name,
    scripts: packageJson?.scripts,
    hasPnpmWorkspace: pnpmWorkspace,
    hasTurboJson: !!turboJson,
    capabilities,
    instructions,
  };

  // ─── Monorepo map (cheap) ─────────────────────────────────
  let monorepo: any = { apps: [], packages: [] };
  const appsDir = join(cwd, "apps");
  const packagesDir = join(cwd, "packages");
  try {
    if (existsSync(appsDir)) {
      const apps = await readdir(appsDir, { withFileTypes: true });
      for (const app of apps) {
        if (!app.isDirectory()) continue;
        try {
          const pkg = JSON.parse(readFileSync(join(appsDir, app.name, "package.json"), "utf8"));
          monorepo.apps.push({ name: app.name, packageName: pkg.name, dependencies: Object.keys(pkg.dependencies || {}) });
        } catch {}
      }
    }
  } catch {}
  try {
    if (existsSync(packagesDir)) {
      const pkgs = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        try {
          const p = JSON.parse(readFileSync(join(packagesDir, pkg.name, "package.json"), "utf8"));
          monorepo.packages.push({ name: pkg.name, packageName: p.name, dependencies: Object.keys(p.dependencies || {}) });
        } catch {}
      }
    }
  } catch {}

  // ─── Routes & Collections (lazy — loaded via cache from ast-tools) ──
  let routes: any[] = [];
  let collections: any[] = [];

  if (capabilities.nextjs) {
    try {
      const nextRes = await nextRouteMapTool(cwd);
      const nextData = JSON.parse((nextRes.content[0] as any).text);
      routes = nextData.routes || [];
    } catch {}
  }

  if (capabilities.payload) {
    try {
      const payloadRes = await payloadSchemaMapTool(cwd);
      const payloadData = JSON.parse((payloadRes.content[0] as any).text);
      collections = payloadData.collections || [];
    } catch {}
  }

  // ─── Structural fallback (monorepo) ───────────────────────
  if (routes.length === 0 && capabilities.monorepo) {
    try {
      const apps = await readdir(join(cwd, "apps"), { withFileTypes: true });
      for (const app of apps) {
        if (!app.isDirectory()) continue;
        const appPath = join(cwd, "apps", app.name);
        if (routes.length === 0) {
          try { const r = JSON.parse(((await nextRouteMapTool(appPath)).content[0] as any).text); routes = r.routes || []; } catch {}
        }
        if (collections.length === 0) {
          try { const r = JSON.parse(((await payloadSchemaMapTool(appPath)).content[0] as any).text); collections = r.collections || []; } catch {}
        }
      }
    } catch {}
  }

  const index: WorkspaceIndex = { bootstrap, monorepo, routes, collections, indexedAt: Date.now() };
  indexCache.set(workspaceId, index);
  return index;
}

export function summarizeIndex(index: WorkspaceIndex): any {
  return {
    name: index.bootstrap.name,
    packageManager: index.bootstrap.packageManager,
    capabilities: index.bootstrap.capabilities,
    gitBranch: index.bootstrap.gitStatus?.split("\n")[0] || "unknown",
    routeCount: index.routes.length,
    collectionCount: index.collections.length,
    appsCount: index.monorepo?.apps?.length || 0,
    packagesCount: index.monorepo?.packages?.length || 0,
  };
}
