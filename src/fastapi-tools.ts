import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export interface FastApiRoute {
  file: string;
  router: string;
  method: string;
  path: string;
  handler?: string;
}

/** Bounded structural discovery for conventional FastAPI applications. */
export async function discoverFastApi(cwd: string): Promise<{ detected: boolean; entrypoints: string[]; routers: string[]; routes: FastApiRoute[] }> {
  const files = await pythonFiles(cwd);
  const entrypoints: string[] = [];
  const routers: string[] = [];
  const routes: FastApiRoute[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = relative(cwd, file).replace(/\\/g, "/");
    if (/\bFastAPI\s*\(/.test(content)) entrypoints.push(rel);
    if (/\bAPIRouter\s*\(/.test(content)) routers.push(rel);
    const pattern = /@(?:(\w+)\.)?(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["'][^)]*\)\s*(?:async\s+)?def\s+(\w+)/g;
    for (const match of content.matchAll(pattern)) {
      routes.push({ file: rel, router: match[1] ?? "app", method: match[2].toUpperCase(), path: match[3], handler: match[4] });
    }
  }
  return { detected: entrypoints.length > 0 || routers.length > 0, entrypoints, routers, routes: routes.slice(0, 100) };
}

async function pythonFiles(root: string, current = root, result: string[] = []): Promise<string[]> {
  if (result.length >= 250 || !existsSync(current)) return result;
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (result.length >= 250) break;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) await pythonFiles(root, full, result);
    } else if (entry.isFile() && entry.name.endsWith(".py")) result.push(full);
  }
  return result;
}
