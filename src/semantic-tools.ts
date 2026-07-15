import { join, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { secureFs } from "./security/secure-fs.js";
import type { ToolResponse } from "./pi-tools.js";
import { codingContextTool } from "./bootstrap-tools.js";
import { nextRouteMapTool, payloadSchemaMapTool } from "./ast-tools.js";

// ─── Token Budget Estimation ─────────────────────────────────
// Rough estimation: ~4 chars/token for code, ~6 chars/token for prose

function estimateTokens(text: string, isCode: boolean = true): number {
  const charsPerToken = isCode ? 4 : 6;
  return Math.ceil(text.length / charsPerToken);
}

export interface ContextBudgetInput {
  paths: string[];
}

export async function contextBudgetTool(input: ContextBudgetInput, cwd: string): Promise<ToolResponse> {
  const results: { path: string; lines?: number; chars?: number; estimatedTokens?: number; notFound?: boolean }[] = [];
  let totalTokens = 0;

  for (const p of input.paths) {
    const fullPath = join(cwd, p);
    try {
      if (!secureFs.exists(cwd, p)) {
        results.push({ path: p, notFound: true, estimatedTokens: 0 });
        continue;
      }
      const stat = secureFs.stat(cwd, p);
      if (!stat.isFile()) {
        results.push({ path: p, notFound: true, estimatedTokens: 0 });
        continue;
      }
      const content = secureFs.readFile(cwd, p);
      const lines = content.split("\n").length;
      const tokens = estimateTokens(content, p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".tsx"));
      totalTokens += tokens;
      results.push({ path: p, lines, chars: content.length, estimatedTokens: tokens });
    } catch {
      results.push({ path: p, notFound: true, estimatedTokens: 0 });
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ files: results, totalEstimatedTokens: totalTokens }, null, 2),
    }],
  };
}

// ─── Semantic Pack ───────────────────────────────────────────
// Gathers the most relevant context from the workspace:
// coding_context + key file contents + file sizes

export interface SemanticPackInput {
  goal?: string;
  maxTokens?: number;
  excludePaths?: string[];
  refresh?: boolean;
}

export async function semanticPackTool(
  cwd: string,
  allowedRoots: string[],
  input: SemanticPackInput = {},
): Promise<ToolResponse> {
  const maxTokens = input.maxTokens ?? 8000;
  const goal = input.goal;
  const excludePaths = input.excludePaths ?? [];
  const excludeSet = new Set(excludePaths.map(p => p.replace(/\\/g, "/")));

  // Get bootstrap context — with goal filtering when provided
  const ctxRes = await codingContextTool(cwd, allowedRoots, goal ? { goal } : undefined);
  const context = JSON.parse((ctxRes.content[0] as any).text);

  // Apply excludePaths: remove already-read files from results
  function applyExcludes<T extends { file?: string; path?: string }>(items: T[]): T[] {
    if (excludePaths.length === 0) return items;
    return items.filter(item => {
      const p = item.file || item.path || "";
      return !excludeSet.has(p.replace(/\\/g, "/"));
    });
  }

  // When a goal is set, codingContextTool returns `relevantRoutes`/`relevantCollections`.
  // Without a goal, it returns `routes`/`collections` directly.
  // We unify both code paths here.
  let routes: any[] = applyExcludes(context.routes || context.relevantRoutes || []);
  let collections: any[] = applyExcludes(context.collections || context.relevantCollections || []);
  const recommendedFiles: any[] = (context.recommendedFiles || [])
    .filter((f: any) => !excludeSet.has(f.path.replace(/\\/g, "/")));
  const grepMatches: string[] = (context.grepMatches || [])
    .filter((p: string) => !excludeSet.has(p.replace(/\\/g, "/")));
  const keywords: string[] = context.keywords || [];

  // ─── Structural Fallback ─────────────────────────────────────
  // If keyword filtering returned nothing (common in monorepos where the workspace
  // root has no app/ directory but apps/web does), fall back to direct scanner calls.
  if (routes.length === 0 || collections.length === 0) {
    // Try to find Next.js app in monorepo sub-directories
    const candidates = [cwd];
    const appsDir = join(cwd, "apps");
    if (existsSync(appsDir)) {
      try {
        const apps = await readdir(appsDir, { withFileTypes: true });
        for (const app of apps) {
          if (app.isDirectory()) candidates.push(join(appsDir, app.name));
        }
      } catch {}
    }

    // Scan all candidates until we find routes/collections
    for (const candidate of candidates) {
      if (routes.length === 0) {
        try {
          const nextRes = await nextRouteMapTool(candidate);
          const nextData = JSON.parse((nextRes.content[0] as any).text);
          if (nextData.routes?.length > 0) {
            routes = nextData.routes;
            // Annotate with source app for monorepo clarity
            if (candidate !== cwd) {
              routes = routes.map((r: any) => ({ ...r, app: candidate.replace(cwd, "").replace(/^[\/\\]/, "") }));
            }
          }
        } catch {}
      }
      if (collections.length === 0) {
        try {
          const payloadRes = await payloadSchemaMapTool(candidate);
          const payloadData = JSON.parse((payloadRes.content[0] as any).text);
          if (payloadData.collections?.length > 0) {
            collections = payloadData.collections;
            if (candidate !== cwd) {
              collections = collections.map((c: any) => ({ ...c, app: candidate.replace(cwd, "").replace(/^[\/\\]/, "") }));
            }
          }
        } catch {}
      }
      if (routes.length > 0 && collections.length > 0) break;
    }
  }

  const pack: any = {
    goal: goal || "overview",
    project: {
      name: context.name,
      framework: context.framework,
      cms: context.cms,
      languages: context.languages,
      primaryApp: context.primaryApp,
      scripts: context.scripts,
    },
    git: context.git,
    routes: routes.slice(0, 20),
    collections: collections.slice(0, 10),
    keyDependencies: context.dependencies?.slice(0, 30),
  };

  // ─── Recommended Files ──────────────────────────────────────
  // Surface the relevance-tagged files from coding_context
  if (recommendedFiles.length > 0) {
    pack.recommendedFiles = recommendedFiles.slice(0, 15);
  }

  // ─── Recommended Workflow ──────────────────────────────────
  // Build a simple inspection sequence from recommended files
  if (goal && recommendedFiles.length > 0) {
    const workflow: any[] = [];
    const directFiles = recommendedFiles.filter((f: any) => f.relevanceTier === "direct");
    const otherFiles = recommendedFiles.filter((f: any) => f.relevanceTier !== "direct");

    // Suggest reading direct files first
    for (const f of directFiles.slice(0, 3)) {
      workflow.push({
        action: "read",
        arguments: { path: f.path },
        reason: f.reason || "Diretamente relevante ao objetivo",
      });
    }

    // Suggest grep for broader search
    if (grepMatches.length > 0) {
      workflow.push({
        action: "grep",
        arguments: { pattern: keywords.slice(0, 3).join("|") },
        reason: `Buscar referências adicionais (${grepMatches.length} arquivos candidatos)`,
      });
    }

    // Suggest run_package_script for verification
    if (context.scripts?.test || context.scripts?.["test:smoke"] || context.scripts?.typecheck) {
      const verificationScript = context.scripts["test:smoke"] ? "test:smoke" : context.scripts.typecheck ? "typecheck" : context.scripts.test ? "test" : undefined;
      if (verificationScript) {
        workflow.push({
          action: "run_package_script",
          arguments: { script: verificationScript, outputMode: "diagnostic-summary" },
          reason: "Verificar impacto das mudanças",
        });
      }
    }

    if (workflow.length > 0) {
      pack.recommendedWorkflow = workflow;
    }
  }

  // Hint when fallback was used — so the model understands the scan scope
  if (goal && (context.relevantRoutes?.length === 0 || context.relevantCollections?.length === 0) && routes.length > 0) {
    pack._note = `Keyword filter for goal '${goal}' returned no matches. Showing full structural scan instead. Filter routes/collections above by goal keyword if needed.`;
  }

  // ─── Budget overflow guard ────────────────────────────────────
  // If the base pack (routes + collections alone) already exceeds maxTokens,
  // progressively trim until it fits. This prevents the pack from being useless
  // on large monorepos with hundreds of routes.
  let baseTokens = estimateTokens(JSON.stringify(pack), false);
  if (baseTokens > maxTokens) {
    // Step 1: strip file contents from routes (keep only path/method/app)
    pack.routes = pack.routes.map((r: any) => ({ path: r.path, method: r.method, app: r.app }));
    pack.collections = pack.collections.map((c: any) => ({ slug: c.slug, app: c.app }));
    baseTokens = estimateTokens(JSON.stringify(pack), false);
  }
  if (baseTokens > maxTokens) {
    // Step 2: hard-cap routes to 10, collections to 5
    pack.routes = pack.routes.slice(0, 10);
    pack.collections = pack.collections.slice(0, 5);
    pack._truncated = true;
    baseTokens = estimateTokens(JSON.stringify(pack), false);
  }
  // ─────────────────────────────────────────────────────────────

  // ─── Relevant File Contents ─────────────────────────────────
  let usedTokens = baseTokens;
  if (goal && usedTokens < maxTokens) {
    const relevantFiles: string[] = [];

    // Collect files from relevant routes and collections (goal-filtered if available)
    const goalRoutes = context.relevantRoutes || routes;
    const goalCollections = context.relevantCollections || collections;

    for (const r of goalRoutes) {
      if (r.file) relevantFiles.push(r.file);
    }
    for (const c of goalCollections) {
      if (c.file) relevantFiles.push(c.file);
    }

    const { compressAST } = await import("./context-engine/compressors.js");
    const fileContents: any[] = [];

    for (const file of relevantFiles.slice(0, 10)) {
      const fullPath = join(cwd, file);
      if (!secureFs.exists(cwd, file)) continue;

      const stat = secureFs.stat(cwd, file);
      const content = secureFs.readFile(cwd, file);

      const levels = ["none", "light", "balanced", "skeletal"] as const;
      let finalCompression = null;
      let finalContent = "";
      let finalTokens = 0;

      for (const level of levels) {
        const compressed = compressAST(content, level, undefined, fullPath, stat.mtimeMs);
        const estTokens = compressed.metadata.outputTokensEstimate;

        if (usedTokens + estTokens <= maxTokens) {
          finalCompression = level;
          finalContent = compressed.output;
          finalTokens = estTokens;
          break;
        }
      }

      if (finalCompression) {
        fileContents.push({ path: file, compression: finalCompression, content: finalContent });
        usedTokens += finalTokens;
      } else {
        const skeletal = compressAST(content, "skeletal", undefined, fullPath, stat.mtimeMs);
        const remainingChars = (maxTokens - usedTokens) * 4;
        if (remainingChars > 100) {
          fileContents.push({
            path: file,
            compression: "truncated",
            content: skeletal.output.substring(0, remainingChars) + "\n... [truncated]",
          });
          usedTokens = maxTokens;
        }
        break;
      }
    }

    if (fileContents.length > 0) {
      pack.relevantFiles = fileContents;
    }
  }

  pack.tokenBudget = { used: usedTokens, max: maxTokens, remaining: maxTokens - usedTokens };

  return {
    content: [{ type: "text", text: JSON.stringify(pack, null, 2) }],
  };
}
