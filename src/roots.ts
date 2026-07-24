// ═══════════════════════════════════════════════════════════════
// PATH POLICY — filesystem boundary enforcement
//
// Centralized path resolution and access control for the Agentic
// MCP server. All filesystem operations flow through these guards.
// ═══════════════════════════════════════════════════════════════

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

const HOME_DIR = normalize(homedir());

export class AccessDeniedError extends Error {
  public readonly requestedPath: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "AccessDeniedError";
    this.requestedPath = path;
  }
}

export function expandHomePath(raw: string): string {
  if (raw === "~") return HOME_DIR;
  if (raw.length > 1 && raw[0] === "~" && (raw[1] === "/" || raw[1] === "\\")) {
    return resolve(HOME_DIR, raw.slice(2));
  }
  return raw;
}

function pathInside(root: string, target: string): boolean {
  if (target === root) return true;
  if (target.startsWith(root + sep)) return true;
  try {
    const real = realpathSync(root);
    if (target === real || target.startsWith(real + sep)) return true;
  } catch {}
  return false;
}

export function isPathInsideRoot(candidate: string, root: string): boolean {
  const a = resolve(expandHomePath(candidate));
  const b = resolve(expandHomePath(root));
  return pathInside(b, a);
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const canonical = resolve(expandHomePath(path));
  for (const root of allowedRoots) {
    if (pathInside(resolve(expandHomePath(root)), canonical)) {
      return canonical;
    }
  }
  throw new AccessDeniedError("Path outside allowed roots: " + path, canonical);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  return assertAllowedPath(resolve(cwd, expandHomePath(inputPath)), allowedRoots);
}
