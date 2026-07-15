import { readFileSync, writeFileSync, statSync, lstatSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspacePath } from "./path-resolution.js";
import { assertPathOperationAllowed } from "./secret-policy.js";

/**
 * A secure wrapper around the FileSystem.
 * All file operations MUST go through this module to ensure 
 * they don't escape the workspace root or leak secrets.
 */
export const secureFs = {
  
  readFile: (workspaceRoot: string, inputPath: string, encoding: "utf8" | "base64" = "utf8"): string => {
    const { canonicalPath } = resolveWorkspacePath(workspaceRoot, inputPath, false);
    assertPathOperationAllowed(canonicalPath, "read");
    // Explicitly cast to string since we are passing an encoding parameter that guarantees a string return
    return readFileSync(canonicalPath, encoding) as string;
  },

  writeFile: (workspaceRoot: string, inputPath: string, content: string | Buffer): void => {
    const { canonicalPath } = resolveWorkspacePath(workspaceRoot, inputPath, true);
    assertPathOperationAllowed(canonicalPath, "write");
    writeFileSync(canonicalPath, content);
  },

  stat: (workspaceRoot: string, inputPath: string) => {
    const { canonicalPath } = resolveWorkspacePath(workspaceRoot, inputPath, false);
    assertPathOperationAllowed(canonicalPath, "read");
    return statSync(canonicalPath);
  },

  exists: (workspaceRoot: string, inputPath: string): boolean => {
    try {
      const { canonicalPath, exists } = resolveWorkspacePath(workspaceRoot, inputPath, true);
      if (exists) {
        // Even for exists check, we shouldn't let them probe secret files existence ideally,
        // but checking existence is generally safer. We'll enforce policy anyway.
        assertPathOperationAllowed(canonicalPath, "read");
      }
      return exists;
    } catch {
      return false;
    }
  },

  listDirectory: (workspaceRoot: string, inputPath: string): string[] => {
    const { canonicalPath } = resolveWorkspacePath(workspaceRoot, inputPath, false);
    assertPathOperationAllowed(canonicalPath, "read");
    return readdirSync(canonicalPath);
  },

  walkFiles: (workspaceRoot: string, inputPath: string): string[] => {
    const { canonicalPath } = resolveWorkspacePath(workspaceRoot, inputPath, false);
    assertPathOperationAllowed(canonicalPath, "read");

    const files: string[] = [];
    const walk = (dir: string) => {
      const items = readdirSync(dir);
      for (const item of items) {
        const itemPath = join(dir, item);
        try {
          // Check secret policy before traversing
          assertPathOperationAllowed(itemPath, "read");
          
          const stat = lstatSync(itemPath);
          if (stat.isSymbolicLink()) {
            continue; // Skip symlinks to prevent recursion and escapes
          }
          if (stat.isDirectory()) {
            walk(itemPath);
          } else {
            files.push(itemPath);
          }
        } catch {
          // If a file throws access denied, skip it silently in walk
        }
      }
    };

    walk(canonicalPath);
    return files;
  }
};
