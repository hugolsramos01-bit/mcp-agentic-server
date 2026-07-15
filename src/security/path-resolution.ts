import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { homedir } from "node:os";
import { AccessDeniedError } from "../roots.js";

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

export interface ResolvedWorkspacePath {
  /** The fully resolved, canonicalized path to the file/directory */
  canonicalPath: string;
  /** Whether the leaf node exists on disk */
  exists: boolean;
}

/**
 * Robustly resolves a path within a workspace root.
 * Ensures that symlinks or path traversal (../) cannot escape the workspace root.
 */
export function resolveWorkspacePath(
  root: string,
  inputPath: string,
  allowMissingLeaf: boolean = true
): ResolvedWorkspacePath {
  const resolvedRoot = resolve(expandHomePath(root));
  
  // Make sure the root itself exists and get its real canonical path
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Workspace root does not exist: ${root}`);
  }
  const canonicalRoot = realpathSync(resolvedRoot);

  // Lexically resolve the input path against the root
  // This collapses any direct ../ in the string
  const lexicallyResolvedPath = resolve(canonicalRoot, expandHomePath(inputPath));

  // We need to walk up the tree to find the closest existing ancestor
  // so we can apply realpathSync to it and verify it hasn't escaped the workspace via symlinks.
  let closestExistingPath = lexicallyResolvedPath;
  const missingSegments: string[] = [];

  while (!existsSync(closestExistingPath)) {
    const parent = resolve(closestExistingPath, "..");
    if (parent === closestExistingPath) {
      // Reached the root of the filesystem without finding an existing path
      break;
    }
    const basename = relative(parent, closestExistingPath);
    missingSegments.unshift(basename);
    closestExistingPath = parent;
  }

  if (!existsSync(closestExistingPath)) {
    throw new AccessDeniedError(`Path resolution failed. No existing ancestors found for: ${inputPath}`);
  }

  // Canonicalize the closest existing ancestor
  const canonicalAncestor = realpathSync(closestExistingPath);

  // Verify the ancestor is inside the workspace root
  const relationship = relative(canonicalRoot, canonicalAncestor);
  const isInside =
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`));

  if (!isInside) {
    throw new AccessDeniedError(`Path escapes workspace root: ${inputPath}`);
  }

  // Rebuild the final canonical path (the ancestor + any non-existent leaf parts)
  const canonicalPath = missingSegments.length > 0 
    ? resolve(canonicalAncestor, ...missingSegments) 
    : canonicalAncestor;

  // Final check: the rebuilt path should also lexicaly be inside the root
  // (This handles cases where missing segments theoretically pointed back out, 
  // though resolve() earlier already collapsed ../)
  const finalRelationship = relative(canonicalRoot, canonicalPath);
  const isFinalInside =
    finalRelationship === "" ||
    (!isAbsolute(finalRelationship) &&
      !finalRelationship.startsWith("..") &&
      finalRelationship !== ".." &&
      !finalRelationship.includes(`..${sep}`));

  if (!isFinalInside) {
    throw new AccessDeniedError(`Reconstructed path escapes workspace root: ${inputPath}`);
  }

  const exists = missingSegments.length === 0;

  if (!allowMissingLeaf && !exists) {
    throw new Error(`Path does not exist: ${inputPath}`);
  }

  return {
    canonicalPath,
    exists,
  };
}
