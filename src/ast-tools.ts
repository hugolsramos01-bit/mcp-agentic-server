import { join, basename, relative, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import type { ToolResponse } from "./pi-tools.js";

// --- Cache Mechanism ---
const astCache = new Map<string, { mtimeMs: number; size: number; data: any }>();
const CACHE_MAX_SIZE = 1000;

function getCachedParsedCollection(filePath: string): any {
  const stats = statSync(filePath);
  const cacheKey = filePath;
  const cached = astCache.get(cacheKey);

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // True LRU: delete and re-insert to move to end
    astCache.delete(cacheKey);
    astCache.set(cacheKey, cached);
    return cached.data;
  }

  const content = readFileSync(filePath, "utf8");
  const data = parseCollectionFile(content);
  
  if (astCache.size >= CACHE_MAX_SIZE) {
    const firstKey = astCache.keys().next().value;
    if (firstKey) astCache.delete(firstKey);
  }
  
  astCache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, data });
  return data;
}

// ─── Route Manifest Cache ─────────────────────────────────────
// Caches the route map based on directory mtime + file count,
// so repeated calls in the same turn skip directory traversal.

interface RouteManifestEntry {
  routeManifest: any[];
  files: { path: string; mtimeMs: number; size: number }[];
  timestamp: number;
}

const routeManifestCache = new Map<string, RouteManifestEntry>();
const ROUTE_CACHE_TTL_MS = 60_000; // 1 minute

function getRouteManifestKey(dir: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    const stats = statSync(dir);
    return `${dir}:mtime=${stats.mtimeMs}:size=${stats.size}`;
  } catch { return null; }
}

function getCachedRouteManifest(dir: string): any[] | null {
  const key = getRouteManifestKey(dir);
  if (!key) return null;
  const cached = routeManifestCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < ROUTE_CACHE_TTL_MS) {
    // Verify each file still matches cached mtime/size
    const allValid = cached.files.every(f => {
      try {
        const s = statSync(f.path);
        return s.mtimeMs === f.mtimeMs && s.size === f.size;
      } catch { return false; }
    });
    if (allValid) return cached.routeManifest;
  }
  return null;
}

function setCachedRouteManifest(dir: string, manifest: any[]): void {
  const key = getRouteManifestKey(dir);
  if (!key) return;
  try {
    const files = manifest
      .map((r: any) => r.file)
      .filter(Boolean)
      .map((f: string) => {
        try {
          const s = statSync(f);
          return { path: f, mtimeMs: s.mtimeMs, size: s.size };
        } catch { return null; }
      })
      .filter(Boolean) as { path: string; mtimeMs: number; size: number }[];
    
    // LRU eviction
    if (routeManifestCache.size >= 100) {
      const firstKey = routeManifestCache.keys().next().value;
      if (firstKey) routeManifestCache.delete(firstKey);
    }
    routeManifestCache.set(key, { routeManifest: manifest, files, timestamp: Date.now() });
  } catch {}
}

// ─── Collection Schema Cache (same strategy) ──────────────────

const collectionCache = new Map<string, RouteManifestEntry>();

function getCachedCollections(dir: string): any[] | null {
  const key = getRouteManifestKey(dir);
  if (!key) return null;
  const cached = collectionCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < ROUTE_CACHE_TTL_MS) return cached.routeManifest;
  return null;
}

function setCachedCollections(dir: string, collections: any[]): void {
  const key = getRouteManifestKey(dir);
  if (!key) return;
  if (collectionCache.size >= 100) {
    const firstKey = collectionCache.keys().next().value;
    if (firstKey) collectionCache.delete(firstKey);
  }
  collectionCache.set(key, { routeManifest: collections, files: [], timestamp: Date.now() });
}

// --- Next.js Route Map ---

export interface NextRouteMapInput {}

export async function nextRouteMapTool(cwd: string, basePath?: string): Promise<ToolResponse> {
  // If a basePath is provided (e.g. "apps/web"), search relative to it
  const searchRoot = basePath ? join(cwd, basePath) : cwd;
  const appDir = existsSync(join(searchRoot, "src/app")) ? join(searchRoot, "src/app") : existsSync(join(searchRoot, "app")) ? join(searchRoot, "app") : null;
  const pagesDir = existsSync(join(searchRoot, "src/pages")) ? join(searchRoot, "src/pages") : existsSync(join(searchRoot, "pages")) ? join(searchRoot, "pages") : null;
  
  if (!appDir && !pagesDir) {
    return { content: [{ type: "text", text: "No app/ or pages/ directory found in the workspace." }] };
  }

  // Try cache for the primary app directory
  const cacheDir = appDir || pagesDir;
  if (cacheDir) {
    const cached = getCachedRouteManifest(cacheDir);
    if (cached) {
      return { content: [{ type: "text", text: JSON.stringify({ routes: cached, cached: true }, null, 2) }] };
    }
  }

  const routes: any[] = [];

  async function walk(dir: string, rootDir: string, type: "app" | "pages") {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rootDir, type);
      } else {
        const name = entry.name.toLowerCase();
        if (type === "app") {
          const appFiles = ["page", "layout", "loading", "error", "not-found", "route"];
          const fileBase = name.substring(0, name.lastIndexOf('.'));
          if (appFiles.includes(fileBase)) {
            const rel = relative(rootDir, dir).replace(/\\/g, "/");
            const segments = rel.split("/").filter(s => s !== "");
            
            const routeGroups = segments.filter(s => s.startsWith("(") && s.endsWith(")")).map(s => s.slice(1, -1));
            const cleanSegments = segments.filter((s) => !s.startsWith("(") && !s.startsWith("@"));
            
            const isDynamic = cleanSegments.some(s => s.startsWith("[") && s.endsWith("]"));
            
            const cleanRel = cleanSegments.join("/");
            const routePath = cleanRel === "" ? "/" : `/${cleanRel}`;
            
            const role = fileBase === "route" ? "api" : fileBase;
            
            routes.push({ type: "app", role, path: routePath, file: relative(rootDir, join(dir, entry.name)).replace(/\\/g, "/"), isDynamic, routeGroups });
          }
        } else {
          if (name.endsWith(".tsx") || name.endsWith(".ts") || name.endsWith(".jsx") || name.endsWith(".js")) {
            if (name.startsWith("_")) continue;
            let rel = relative(rootDir, join(dir, entry.name)).replace(/\\/g, "/");
            rel = rel.replace(/\.[tj]sx?$/, ""); // remove extension
            
            const isApi = rel.startsWith("api/");
            const role = isApi ? "api" : "page";
            
            if (rel.endsWith("/index")) rel = rel.substring(0, rel.length - 6);
            if (rel === "index") rel = "";
            const routePath = `/${rel}`;
            
            const isDynamic = routePath.includes("[") && routePath.includes("]");
            
            routes.push({ type: "pages", role, path: routePath, file: relative(rootDir, join(dir, entry.name)).replace(/\\/g, "/"), isDynamic });
          }
        }
      }
    }
  }

  if (appDir) await walk(appDir, appDir, "app");
  if (pagesDir) await walk(pagesDir, pagesDir, "pages");

  // Save to cache
  if (cacheDir && routes.length > 0) {
    setCachedRouteManifest(cacheDir, routes);
  }

  return { content: [{ type: "text", text: JSON.stringify({ routes }, null, 2) }] };
}

// --- Payload Schema Map ---

export interface PayloadSchemaMapInput {}

export async function payloadSchemaMapTool(cwd: string, basePath?: string): Promise<ToolResponse> {
  // If a basePath is provided (e.g. "apps/web"), search relative to it
  const searchRoot = basePath ? join(cwd, basePath) : cwd;
  
  // Common locations for payload collections
  const possibleDirs = [
    join(searchRoot, "src/collections"),
    join(searchRoot, "collections"),
    join(searchRoot, "src/payload/collections"),
    join(searchRoot, "payload/collections")
  ];
  
  let collectionsDir: string | null = null;
  for (const dir of possibleDirs) {
    if (existsSync(dir)) {
      collectionsDir = dir;
      break;
    }
  }
  
  if (!collectionsDir) {
    return { content: [{ type: "text", text: "No collections directory found (checked src/collections, collections, etc)." }] };
  }

  // Try cache
  const cached = getCachedCollections(collectionsDir);
  if (cached) {
    return { content: [{ type: "text", text: JSON.stringify({ collections: cached, cached: true }, null, 2) }] };
  }

  const collections: any[] = [];

  async function walkTS(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walkTS(join(dir, entry.name));
      } else if (entry.name.endsWith(".ts")) {
        const filePath = join(dir, entry.name);
        try {
          const content = readFileSync(filePath, "utf8");
          const parsed = parseCollectionFile(content);
          if (parsed && parsed.slug) {
            collections.push({
              file: relative(cwd, filePath).replace(/\\/g, "/"),
              ...parsed
            });
          }
        } catch (e) {
          // ignore parsing errors for individual files
        }
      }
    }
  }

  await walkTS(collectionsDir);
  
  // Save to cache
  if (collections.length > 0) setCachedCollections(collectionsDir, collections);
  
  return { content: [{ type: "text", text: JSON.stringify({ collections }, null, 2) }] };
}

function parseCollectionFile(content: string): any {
  const sourceFile = ts.createSourceFile("temp.ts", content, ts.ScriptTarget.Latest, true);
  
  let slug = "";
  const fieldsTree: any[] = [];
  const access: string[] = [];
  const hooks: string[] = [];
  let tenantScoped = false;

  /**
   * Build a tree of field definitions (canonical structure).
   * Returns an array of tree nodes — each node has { name, type, children?, relationTo?, required?, unique? }.
   * Container types (group, array, row, tabs, collapsible) get a children array.
   * Children are NEVER duplicated as top-level entries.
   */
  function parseFieldTree(elements: ts.NodeArray<ts.Expression>): any[] {
    const result: any[] = [];
    for (const el of elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      
      let fieldName = "";
      let fieldType = "";
      let relationTo = "";
      let required = false;
      let unique = false;
      let childFields: ts.NodeArray<ts.Expression> | undefined;
      let blockDefs: ts.NodeArray<ts.Expression> | undefined;
      let tabDefs: ts.NodeArray<ts.Expression> | undefined;

      for (const prop of el.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = prop.name.getText(sourceFile);
        const value = prop.initializer;

        if (propName === "name" && ts.isStringLiteral(value)) {
          fieldName = value.text;
        } else if (propName === "type" && ts.isStringLiteral(value)) {
          fieldType = value.text;
        } else if (propName === "relationTo" && ts.isStringLiteral(value)) {
          relationTo = value.text;
        } else if (propName === "required" && value.kind === ts.SyntaxKind.TrueKeyword) {
          required = true;
        } else if (propName === "unique" && value.kind === ts.SyntaxKind.TrueKeyword) {
          unique = true;
        } else if (propName === "fields" && ts.isArrayLiteralExpression(value)) {
          childFields = value.elements;
        } else if (propName === "blocks" && ts.isArrayLiteralExpression(value)) {
          blockDefs = value.elements;
        } else if (propName === "tabs" && ts.isArrayLiteralExpression(value)) {
          tabDefs = value.elements;
        }
      }

      // Skip anonymous containers (row without name, empty types)
      if (!fieldName && fieldType !== "row") continue;

      // ── Tree node ──
      const node: any = { name: fieldName || `[${fieldType}]`, type: fieldType };
      if (relationTo) node.relationTo = relationTo;
      if (required) node.required = true;
      if (unique) node.unique = true;

      // Check for tenant scoping
      if ((fieldName === "site" || fieldName === "tenant") && fieldType === "relationship") {
        tenantScoped = true;
      }

      // Container types: recurse into children
      const isContainer = ["group", "array", "row", "tabs", "collapsible"].includes(fieldType);

      if (childFields && isContainer) {
        node.children = parseFieldTree(childFields);
      } else if (childFields && !isContainer) {
        // Non-container with fields (e.g. blocks without explicit type)
        node.children = parseFieldTree(childFields);
      }

      // Blocks: each block becomes a child node with its fields
      if (blockDefs) {
        const blockNodes: any[] = [];
        for (const block of blockDefs) {
          if (!ts.isObjectLiteralExpression(block)) continue;
          let blockSlug = "";
          let bf: ts.NodeArray<ts.Expression> | undefined;
          for (const bp of block.properties) {
            if (ts.isPropertyAssignment(bp)) {
              const bn = bp.name.getText(sourceFile);
              if (bn === "slug" && ts.isStringLiteral(bp.initializer)) blockSlug = bp.initializer.text;
              if (bn === "fields" && ts.isArrayLiteralExpression(bp.initializer)) bf = bp.initializer.elements;
            }
          }
          if (blockSlug) {
            const blockNode: any = { name: `[block:${blockSlug}]`, type: "block" };
            if (bf) blockNode.children = parseFieldTree(bf);
            blockNodes.push(blockNode);
          }
        }
        if (blockNodes.length > 0) {
          node.children = (node.children || []).concat(blockNodes);
        }
      }

      // Tabs: each tab becomes a child node with its fields
      if (tabDefs) {
        const tabNodes: any[] = [];
        for (const tab of tabDefs) {
          if (!ts.isObjectLiteralExpression(tab)) continue;
          let tabName = "";
          let tf: ts.NodeArray<ts.Expression> | undefined;
          for (const tp of tab.properties) {
            if (ts.isPropertyAssignment(tp)) {
              const tn = tp.name.getText(sourceFile);
              if (tn === "name" && ts.isStringLiteral(tp.initializer)) tabName = tp.initializer.text;
              if (tn === "fields" && ts.isArrayLiteralExpression(tp.initializer)) tf = tp.initializer.elements;
            }
          }
          if (tabName) {
            const tabNode: any = { name: `[tab:${tabName}]`, type: "tab" };
            if (tf) tabNode.children = parseFieldTree(tf);
            tabNodes.push(tabNode);
          }
        }
        if (tabNodes.length > 0) {
          node.children = (node.children || []).concat(tabNodes);
        }
      }

      result.push(node);
    }
    return result;
  }

  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile);
      if (name === "slug") {
        if (ts.isStringLiteral(node.initializer)) {
          slug = node.initializer.text;
        }
      } else if (name === "fields") {
        if (ts.isArrayLiteralExpression(node.initializer)) {
          fieldsTree.push(...parseFieldTree(node.initializer.elements));
        }
      } else if (name === "access") {
        if (ts.isObjectLiteralExpression(node.initializer)) {
          for (const prop of node.initializer.properties) {
             if (prop.name) access.push(prop.name.getText(sourceFile));
          }
        }
      } else if (name === "hooks") {
        if (ts.isObjectLiteralExpression(node.initializer)) {
          for (const prop of node.initializer.properties) {
             if (prop.name) hooks.push(prop.name.getText(sourceFile));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  
  if (slug) {
    return { slug, tenantScoped, fieldsTree, access, hooks };
  }
  return null;
}

export async function fileDependenciesTool(cwd: string, targetPath: string): Promise<ToolResponse> {
  const execAsync = promisify(exec);
  
  const fullPath = join(cwd, targetPath);
  if (!existsSync(fullPath)) {
    return { content: [{ type: "text", text: `File not found: ${targetPath}` }] };
  }
  
  const content = readFileSync(fullPath, "utf8");
  
  // 1. Outward dependencies — use AST to resolve actual imports
  const sourceFile = ts.createSourceFile(targetPath, content, ts.ScriptTarget.Latest, true);
  const outwards = new Set<string>();
  
  function visitImports(node: ts.Node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      outwards.add(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      outwards.add(node.moduleSpecifier.text);
    }
    // Dynamic imports: import("module")
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg)) {
        outwards.add(arg.text);
      }
    }
    ts.forEachChild(node, visitImports);
  }
  visitImports(sourceFile);
  
  // 2. Inward dependencies — use git grep with exact import pattern instead of filename match
  // Search for: import ... from 'relative/path/to/target' or import 'relative/path/to/target'
  const inwards: string[] = [];
  const ext = extname(targetPath);
  // Build possible import paths (without extension, with index, etc.)
  const importVariants = [
    targetPath.replace(/\\/g, '/').replace(ext, ''),
    targetPath.replace(/\\/g, '/'),
    './' + targetPath.replace(/\\/g, '/').replace(ext, ''),
    '../' + targetPath.replace(/\\/g, '/').replace(ext, ''),
  ];
  
  try {
    const searchPatterns = importVariants.map(v => `from ['"\`]${v}['"\`]`).join('|');
    const { stdout } = await execAsync(`git grep --name-only -E "${searchPatterns}"`, { cwd, maxBuffer: 1024 * 1024 * 10 });
    const files = stdout.split('\n').map((l: string) => l.trim()).filter((l: string) => l && l !== targetPath.replace(/\\/g, '/'));
    for (const f of files) {
       if (!inwards.includes(f)) inwards.push(f);
    }
  } catch (e) {
    // If grep fails, fallback to simple filename-based search
    try {
      const fileBase = basename(targetPath, ext);
      const { stdout } = await execAsync(`git grep --name-only ${fileBase}`, { cwd, maxBuffer: 1024 * 1024 * 10 });
      const files = stdout.split('\n').map((l: string) => l.trim()).filter((l: string) => l && l !== targetPath.replace(/\\/g, '/'));
      for (const f of files) {
         if (!inwards.includes(f)) inwards.push(f);
      }
    } catch {}
  }
  
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        target: targetPath,
        outward_dependencies: Array.from(outwards),
        inward_dependencies: inwards
      }, null, 2)
    }]
  };
}



