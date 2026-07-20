import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

/**
 * Normalizes package manager executable names to handle Windows `.cmd` extensions.
 */
export async function resolveExecutable(executable: string, cwd: string): Promise<string> {
  const isWindows = os.platform() === "win32";

  if (!isWindows) {
    return executable;
  }

  // Common npm/yarn/pnpm commands on Windows often need the .cmd extension 
  // when `shell: false` is used in child_process.
  const packageManagers = ["npm", "pnpm", "yarn", "npx"];

  if (packageManagers.includes(executable)) {
    // Return with .cmd. The OS PATH resolution will find it if it exists.
    return `${executable}.cmd`;
  }

  return executable;
}
