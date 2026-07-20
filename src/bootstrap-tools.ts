import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResponse } from "./pi-tools.js";
import { resolveAllowedPath } from "./roots.js";
import { treeTool, workspaceSummaryTool } from "./assistant-tools.js";
import { nextRouteMapTool, payloadSchemaMapTool } from "./ast-tools.js";
import { readWorkspaceKnowledge } from "./knowledge-tools.js";
import { getWorkspaceGitEligibility } from "./git.js";

const execFileAsync = promisify(execFile);

export interface ProjectBootstrapInput {}

export async function projectBootstrapTool(cwd: string, allowedRoots: string[]): Promise<ToolResponse> {
  const isGitRepo = existsSync(join(cwd, ".git"));
  let packageJson: any = null;
  
  try {
    const pkgContent = readFileSync(join(cwd, "package.json"), "utf8");
    packageJson = JSON.parse(pkgContent);
  } catch (e) {
    // Ignore
  }

  let pnpmWorkspace: string | null = null;
  let turboJson: any = null;
  try {
    if (existsSync(join(cwd, "pnpm-workspace.yaml"))) pnpmWorkspace = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
    if (existsSync(join(cwd, "turbo.json"))) turboJson = JSON.parse(readFileSync(join(cwd, "turbo.json"), "utf8"));
  } catch (e) {}

  let deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  let allDeps = Object.keys(deps);

  // Aggregate deps from monorepo subdirectories
  try {
    if (existsSync(join(cwd, "apps"))) {
      const apps = readdirSync(join(cwd, "apps"), { withFileTypes: true });
      for (const app of apps) {
        if (!app.isDirectory()) continue;
        try {
          const subPkg = JSON.parse(readFileSync(join(cwd, "apps", app.name, "package.json"), "utf8"));
          const subDeps = { ...(subPkg.dependencies || {}), ...(subPkg.devDependencies || {}) };
          for (const d of Object.keys(subDeps)) allDeps.push(d);
        } catch {}
      }
    }
  } catch {}
  try {
    if (existsSync(join(cwd, "packages"))) {
      const pkgs = readdirSync(join(cwd, "packages"), { withFileTypes: true });
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        try {
          const subPkg = JSON.parse(readFileSync(join(cwd, "packages", pkg.name, "package.json"), "utf8"));
          const subDeps = { ...(subPkg.dependencies || {}), ...(subPkg.devDependencies || {}) };
          for (const d of Object.keys(subDeps)) allDeps.push(d);
        } catch {}
      }
    }
  } catch {}

  const capabilities = {
    git: isGitRepo,
    node: true,
    monorepo: !!pnpmWorkspace || existsSync(join(cwd, "apps")),
    nextjs: allDeps.some(d => d === "next" || d.startsWith("next-")),
    payload: allDeps.some(d => d.startsWith("@payloadcms/") || d === "payload"),
    react: allDeps.some(d => d === "react" || d === "react-dom"),
    python: existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py")),
    typescript: allDeps.some(d => d === "typescript") || existsSync(join(cwd, "tsconfig.json")) || (existsSync(join(cwd, "apps")) && readdirSync(join(cwd, "apps"), { withFileTypes: true }).some(d => d.isDirectory() && existsSync(join(cwd, "apps", d.name, "tsconfig.json")))) || (existsSync(join(cwd, "packages")) && readdirSync(join(cwd, "packages"), { withFileTypes: true }).some(d => d.isDirectory() && existsSync(join(cwd, "packages", d.name, "tsconfig.json")))),
    vitest: allDeps.some(d => d === "vitest" || d.startsWith("@vitest/")),
  };

  let gitStatus = "";
  if (isGitRepo) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], { cwd });
      gitStatus = stdout;
    } catch (e) {}
  }

  let instructions: string[] = [];
  try {
    const files = await readdir(cwd);
    const mdFiles = files.filter(f => f.toLowerCase().includes("readme") || f.toLowerCase().includes("instruction"));
    for (const file of mdFiles) {
      instructions.push(`--- ${file} ---\n${readFileSync(join(cwd, file), "utf8").substring(0, 1000)}...`);
    }
  } catch (e) {}

  let treeRes = await treeTool({ depth: 2 }, cwd, allowedRoots);
  let tree = (treeRes.content[0] as any).text;

  const summary = {
    root: cwd,
    projectRoot: cwd,
    packageManager: existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(cwd, "yarn.lock")) ? "yarn" : "npm",
    isGitRepo,
    gitStatus,
    hasPackageJson: !!packageJson,
    name: packageJson?.name,
    scripts: packageJson?.scripts,
    hasPnpmWorkspace: !!pnpmWorkspace,
    hasTurboJson: !!turboJson,
    capabilities,
    tree,
    instructions: instructions.length > 0 ? instructions : "No instructions found"
  };

  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
  };
}

export interface MonorepoMapInput {}

export async function monorepoMapTool(cwd: string): Promise<ToolResponse> {
  const appsDir = join(cwd, "apps");
  const packagesDir = join(cwd, "packages");
  
  const map: any = { apps: [], packages: [] };
  
  try {
    if (existsSync(appsDir)) {
      const apps = await readdir(appsDir, { withFileTypes: true });
      for (const app of apps) {
        if (app.isDirectory()) {
          try {
            const pkg = JSON.parse(readFileSync(join(appsDir, app.name, "package.json"), "utf8"));
            map.apps.push({ name: app.name, packageName: pkg.name, dependencies: Object.keys(pkg.dependencies || {}) });
          } catch (e) {
            map.apps.push({ name: app.name, error: "No package.json" });
          }
        }
      }
    }
  } catch (e) {}

  try {
    if (existsSync(packagesDir)) {
      const pkgs = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of pkgs) {
        if (pkg.isDirectory()) {
          try {
            const p = JSON.parse(readFileSync(join(packagesDir, pkg.name, "package.json"), "utf8"));
            map.packages.push({ name: pkg.name, packageName: p.name, dependencies: Object.keys(p.dependencies || {}) });
          } catch (e) {
            map.packages.push({ name: pkg.name, error: "No package.json" });
          }
        }
      }
    }
  } catch (e) {}

  return {
    content: [{ type: "text", text: JSON.stringify(map, null, 2) }]
  };
}

export interface ChangedFilesSummaryInput {}

export async function changedFilesSummaryTool(cwd: string): Promise<ToolResponse> {
  try {
    const eligibility = await getWorkspaceGitEligibility(cwd);
    if (!eligibility.ok) {
      return { content: [{ type: "text", text: `Changed-files summary unavailable: ${eligibility.message ?? "workspace is not a Git repository."}` }], isError: true };
    }
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--no-renames"], { cwd });
    if (!stdout.trim()) {
      return { content: [{ type: "text", text: "No changed files." }] };
    }
    
    const summary: any[] = [];
    
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.length < 3) continue;
      const status = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      if (!filePath) continue;
      summary.push({ file: filePath, status });
    }
    
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error running git diff: ${e.message}` }],
      isError: true
    };
  }
}
export interface CodingContextInput {
  goal?: string;
}

export async function codingContextTool(cwd: string, allowedRoots: string[], input?: CodingContextInput): Promise<ToolResponse> {
  const bootstrapRes = await projectBootstrapTool(cwd, allowedRoots);
  const monorepoRes = await monorepoMapTool(cwd);
  const nextRes = await nextRouteMapTool(cwd);
  const payloadRes = await payloadSchemaMapTool(cwd);
  const summaryRes = await workspaceSummaryTool(cwd);
  
  let baseContext: any = {};
  try { baseContext = JSON.parse((bootstrapRes.content[0] as any).text); } catch(e) {}
  
  let monorepoContext = {};
  try { monorepoContext = JSON.parse((monorepoRes.content[0] as any).text); } catch(e) {}
  
  let nextRoutes: any = { routes: [] };
  try { nextRoutes = JSON.parse((nextRes.content[0] as any).text); } catch(e) {}
  
  let payloadSchema: any = { collections: [] };
  try { payloadSchema = JSON.parse((payloadRes.content[0] as any).text); } catch(e) {}
  
  let summaryContext = {};
  try { summaryContext = JSON.parse((summaryRes.content[0] as any).text); } catch(e) {}
  
  let routes = nextRoutes.routes || [];
  let collections = payloadSchema.collections || [];
  
  // If goal is provided, filter context to only relevant items
  if (input?.goal) {
    const rawGoal = input.goal.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    // Clean punctuation and normalize whitespace
    const goal = rawGoal.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // ─── Keyword expansion ──────────────────────────────────────
    // Split goal into tokens, add common synonyms and inflection variants.
    // Strip stopwords (English + Portuguese) so "tenant security and admin isolation" → ["tenant", "security", "admin", "isolation"]
    const STOPWORDS = new Set([
      // English
      "a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "with", "at", "by", "is",
      "as", "be", "it", "no", "not", "from", "this", "that", "but", "if", "so", "all", "can",
      "will", "would", "should", "could", "do", "does", "has", "have", "had", "was", "were",
      "are", "been", "about", "into", "up", "out", "just", "also", "very", "only", "its", "get",
      // Portuguese
      "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas",
      "no", "nos", "o", "os", "para", "por", "pela", "pelas", "pelo", "pelos", "que", "se",
      "sem", "sua", "suas", "seu", "seus", "um", "uma", "umas", "uns", "como", "entre",
      "entender", "avaliar", "melhorar", "usar", "criar", "ver", "ter", "fazer", "sobre",
    ]);
    // NFD-normalize and remove combining marks before token matching
    function normalizeToken(t: string): string { return t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
    const rawTokens = goal.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.filter(t => !STOPWORDS.has(normalizeToken(t)) && t.length > 1);
    const synonyms: Record<string, string[]> = {
      tenant: ["tenant", "tenancy", "org", "organization", "multi-tenant", "multitenant", "multi_tenant", "account", "workspace"],
      auth: ["auth", "authentication", "login", "signin", "oauth", "session", "jwt", "token", "password", "credential"],
      security: ["security", "secure", "safe", "protect", "permission", "acl", "rbac", "access-control", "safety", "vulnerability"],
      middleware: ["middleware", "interceptor", "filter", "hook", "pipe", "chain"],
      permission: ["permission", "role", "access", "allow", "deny", "policy", "capability", "scope", "privilege"],
      isolation: ["isolation", "isolated", "separate", "sandbox", "compartment", "boundary", "partition", "scope", "scoped"],
      api: ["api", "endpoint", "route", "rest", "graphql", "rpc", "handler", "controller"],
      database: ["database", "db", "sql", "query", "collection", "model", "schema", "store", "repository"],
      builder: ["builder", "build", "construct", "factory", "generator", "creator", "page-builder", "pagebuilder", "editor"],
      public: ["public", "client", "frontend", "customer", "user-facing", "external", "open", "unauthenticated", "anonymous"],
    };
    
    // Build expanded keyword list: original tokens + synonyms of any matching key
    const expandedKeywords = new Set(tokens);
    for (const token of tokens) {
      for (const [key, syns] of Object.entries(synonyms)) {
        if (token.includes(key) || key.includes(token) || syns.some(s => s.includes(token) || token.includes(s))) {
          for (const s of syns) expandedKeywords.add(s);
        }
      }
    }
    const keywords = [...expandedKeywords].filter(k => k.length > 2);
    
    // ─── Grep-based matching ────────────────────────────────────
    // Search the codebase for keyword occurrences, then cross-reference
    // with known files from routes, collections, and dependencies.
    let grepMatches: string[] = [];
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      
      // Use git grep for speed (respects .gitignore)
      for (const kw of keywords.slice(0, 5)) { // max 5 grep queries to avoid slowdown
        try {
          const { stdout } = await execFileAsync("git", ["grep", "-il", kw, "--", "."], { cwd, maxBuffer: 1024 * 1024 });
          for (const line of stdout.trim().split("\n").filter(Boolean)) {
            grepMatches.push(line.trim());
          }
        } catch { /* no matches for this keyword */ }
      }
    } catch { /* git grep not available */ }
    // Deduplicate
    grepMatches = [...new Set(grepMatches)];
    
    // ─── Multi-keyword filter ──────────────────────────────────
    // A route/collection matches if ANY expanded keyword appears in its fields.
    function matchesGoal(item: any): boolean {
      const haystack = [
        item.path, item.file, item.slug, item.name,
        ...(item.routeGroups || []),
        ...(item.fields || []),
      ].filter(Boolean).map((s: string) => s.toLowerCase());
      return keywords.some(kw => haystack.some(h => h.includes(kw)));
    }
    
    const relevantRoutes = routes.filter(matchesGoal);
    const relevantCollections = collections.filter(matchesGoal);
    
    // ─── Grep cross-reference — tag matching files ────────────
    // Which of the grep-matched files are relevant to our routes/collections?
    const routeFiles = new Set(relevantRoutes.map((r: any) => r.file).filter(Boolean));
    const collectionFiles = new Set(relevantCollections.map((c: any) => c.file).filter(Boolean));
    const relevantGrepFiles = grepMatches.filter(f => 
      routeFiles.has(f) || collectionFiles.has(f) || 
      f.endsWith(".ts") || f.endsWith(".tsx")
    );
    
    // ─── Build recommendedFiles with deterministic relevance tiers ──
    // Tiers: direct > structural > supporting > textual > excluded
    const GENERATED_PATTERNS = ["generated", "migration", "lockfile", "snapshot", ".test.", ".spec.", "node_modules", "dist", "build"];
    const EXCLUDED_PATTERNS = ["package-lock", "pnpm-lock", "yarn.lock", "tsconfig", ".d.ts"];
    
    function classifyFileTier(file: string, matchedKws: string[]): { tier: string; matchedBy: string[]; reason: string } {
      const matchedBy: string[] = [];
      const basename = file.split("/").pop() || file;
      const ext = basename.includes(".") ? basename.split(".").pop() || "" : "";
      
      // Exclusion patterns
      if (EXCLUDED_PATTERNS.some(p => basename.includes(p))) {
        return { tier: "excluded", matchedBy: ["excluded:lockfile-or-config"], reason: "Arquivo de configuração ou lockfile" };
      }
      if (file.includes("/generated/") || file.includes("/__generated__/")) {
        return { tier: "excluded", matchedBy: ["excluded:generated"], reason: "Arquivo gerado automaticamente" };
      }
      
      // Check if it's a collection/route file
      if (collectionFiles.has(file)) {
        const col = relevantCollections.find((c: any) => c.file === file);
        const kwMatches = keywords.filter(kw => col?.slug?.toLowerCase().includes(kw) || col?.name?.toLowerCase().includes(kw));
        if (kwMatches.length > 0) {
          matchedBy.push(...kwMatches.map((kw: string) => `collection:${kw}`));
        }
        if (col?.slug) matchedBy.push(`collection-slug:${col.slug}`);
      }
      
      if (routeFiles.has(file)) {
        const route = relevantRoutes.find((r: any) => r.file === file);
        const kwMatches = keywords.filter(kw => route?.path?.toLowerCase().includes(kw));
        if (kwMatches.length > 0) {
          matchedBy.push(...kwMatches.map((kw: string) => `route:${kw}`));
        }
        if (route?.path) matchedBy.push(`route-path:${route.path}`);
      }
      
      // Filename match
      const filenameKws = keywords.filter(kw => basename.toLowerCase().includes(kw));
      if (filenameKws.length > 0) {
        matchedBy.push(...filenameKws.map((kw: string) => `filename:${kw}`));
      }
      
      // Content match (from grep)
      const contentKws = matchedKws.filter(kw => !matchedBy.some(m => m.includes(kw)));
      if (contentKws.length > 0) {
        matchedBy.push(...contentKws.map((kw: string) => `content:${kw}`));
      }
      
      // Test file classification
      const isTestFile = basename.includes(".test.") || basename.includes(".spec.");
      const isGeneratedFile = GENERATED_PATTERNS.some(p => file.includes(p));
      
      // Deduplicate
      const uniqueBy = [...new Set(matchedBy)];
      
      // Tier assignment — ONLY filename, route-path, and collection-slug count as direct.
      // Content-only matches (grep hits) are textual, never direct.
      const hasDirect = uniqueBy.some(m => m.startsWith("filename:") || m.startsWith("route-path:") || m.startsWith("collection-slug:"));
      const hasStructural = uniqueBy.some(m => m.startsWith("route:") || m.startsWith("collection:"));
      const hasContent = uniqueBy.some(m => m.startsWith("content:"));
      
      let tier: string;
      if (isGeneratedFile) { tier = "excluded"; }
      else if (isTestFile) { tier = "supporting"; }
      else if (hasDirect) { tier = "direct"; }
      else if (hasStructural) { tier = "structural"; }
      else if (hasContent) { tier = "textual"; }
      else { tier = "textual"; }
      
      const reason = tier === "direct" 
        ? "Nome, rota ou símbolo corresponde diretamente ao objetivo"
        : tier === "structural"
        ? "Estruturalmente relacionado ao objetivo (collection, route)"
        : tier === "supporting"
        ? "Arquivo de teste ou suporte"
        : tier === "textual"
        ? "Contém termos do objetivo — pode ser relevante"
        : "Arquivo excluído (gerado/config)";
      
      return { tier, matchedBy: uniqueBy.slice(0, 8), reason };
    }

    // Build recommendedFiles from all candidate files
    const fileCandidateMap = new Map<string, string[]>();
    for (const kw of keywords) {
      for (const file of relevantGrepFiles) {
        if (!fileCandidateMap.has(file)) fileCandidateMap.set(file, []);
        fileCandidateMap.get(file)!.push(kw);
      }
    }
    // Add route/collection files not yet in grepMatches
    for (const r of relevantRoutes) { if (r.file && !fileCandidateMap.has(r.file)) fileCandidateMap.set(r.file, keywords); }
    for (const c of relevantCollections) { if (c.file && !fileCandidateMap.has(c.file)) fileCandidateMap.set(c.file, keywords); }
    
    const recommendedFiles: any[] = [];
    for (const [file, matchedKws] of fileCandidateMap) {
      const { tier, matchedBy, reason } = classifyFileTier(file, matchedKws);
      if (tier === "excluded") continue;
      
      // Estimate tokens
      let estimatedTokens = 0;
      try {
        const fullPath = join(cwd, file);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf8");
          estimatedTokens = Math.ceil(content.length / (file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".tsx") ? 4 : 6));
        }
      } catch {}
      
      // Recommend read mode based on size + tier
      let recommendedReadMode: string = "balanced";
      if (estimatedTokens < 500) { recommendedReadMode = "full"; }
      else if (tier === "direct" && estimatedTokens < 1500) { recommendedReadMode = "full"; }
      else if (tier === "direct") { recommendedReadMode = "balanced"; }
      else if (estimatedTokens > 3000) { recommendedReadMode = "skeletal"; }
      else if (tier === "textual") { recommendedReadMode = "light"; }
      
      recommendedFiles.push({ path: file, relevanceTier: tier, matchedBy, recommendedReadMode, reason, estimatedTokens });
    }
    
    // Sort: direct first, then structural, supporting, textual; within same tier: more matchedBy first
    const tierOrder: Record<string, number> = { direct: 0, structural: 1, supporting: 2, textual: 3 };
    recommendedFiles.sort((a, b) => {
      const ta = tierOrder[a.relevanceTier] ?? 9;
      const tb = tierOrder[b.relevanceTier] ?? 9;
      if (ta !== tb) return ta - tb;
      return (b.matchedBy?.length ?? 0) - (a.matchedBy?.length ?? 0);
    });
    
    const codingContext: any = {
      goal: input.goal,
      keywords,
      root: baseContext.root || baseContext.workspaceId || cwd,
      git: { branch: baseContext.gitStatus?.split('\n')[0] || 'unknown', status: baseContext.gitStatus || '' },
      capabilities: baseContext.capabilities || {},
      packageManager: baseContext.packageManager || 'unknown',
      scripts: baseContext.scripts || {},
      relevantRoutes,
      relevantCollections,
      recommendedFiles: recommendedFiles.slice(0, 15), // top 15
      grepMatches: relevantGrepFiles.slice(0, 20),
      otherApps: monorepoContext,
    };
    
    if (recommendedFiles.length === 0) {
      codingContext.suggestion = "No specific matches found for your goal. Consider using read_many or grep to explore further. The fallback structural scan below may still provide useful context.";
    } else {
      const directCount = recommendedFiles.filter((f: any) => f.relevanceTier === "direct").length;
      codingContext.suggestion = `${recommendedFiles.length} relevant files found (${directCount} direct). Start with direct-tier files using recommendedReadMode.`;
    }
    
    if (relevantRoutes.length > 0) codingContext.totalRoutes = routes.length;
    if (relevantCollections.length > 0) codingContext.totalCollections = collections.length;
    
    // Inject relevant knowledge
    const knowledge = readWorkspaceKnowledge(cwd, [goal]);
    if (knowledge.length > 0) {
      codingContext.knowledge = knowledge.map((k) => ({
        slug: k.slug,
        timestamp: k.timestamp,
        summary: k.summary,
        content: k.content.substring(0, 300),
      }));
    }
    
    return {
      content: [{ type: "text", text: JSON.stringify(codingContext, null, 2) }]
    };
  }
  
  const codingContext: any = {
    ...baseContext,
    ...summaryContext,
    monorepo: monorepoContext,
    routes,
    collections,
  };
  
  // Inject recent knowledge
  const knowledge = readWorkspaceKnowledge(cwd);
  if (knowledge.length > 0) {
    codingContext.knowledge = knowledge.slice(0, 5).map((k) => ({
      slug: k.slug,
      timestamp: k.timestamp,
      summary: k.summary,
      scopedTo: k.scopedTo,
      content: k.content.substring(0, 200),
    }));
  }
  
  return {
    content: [{ type: "text", text: JSON.stringify(codingContext, null, 2) }]
  };
}

export async function suggestChecksTool(cwd: string): Promise<ToolResponse> {
  let packageJson: any = null;
  try {
    const pkgContent = readFileSync(join(cwd, "package.json"), "utf8");
    packageJson = JSON.parse(pkgContent);
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "No package.json found" }) }] };
  }
  
  const scripts = packageJson.scripts || {};
  const checks = [];
  
  if (scripts["lint"] || scripts["lint:no-ts-ignore"]) {
    checks.push({ script: scripts["lint:no-ts-ignore"] ? "lint:no-ts-ignore" : "lint", reason: "Verificar qualidade do codigo (Linting)" });
  }
  if (scripts["typecheck"]) {
    checks.push({ script: "typecheck", reason: "Verificar tipos TypeScript" });
  }
  if (scripts["test:smoke"] || scripts["test"]) {
    checks.push({ script: scripts["test:smoke"] ? "test:smoke" : "test", reason: "Verificar testes unitarios/smoke" });
  }
  if (scripts["build"]) {
    checks.push({ script: "build", reason: "Garantir que o build compila sem erros" });
  }
  
  return {
    content: [{ type: "text", text: JSON.stringify({ checks }, null, 2) }]
  };
}
