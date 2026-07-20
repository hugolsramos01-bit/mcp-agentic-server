import { createRequire } from "node:module";
import { join } from "node:path";

export interface NativeDependencyVerification {
  ok: boolean;
  failures: Array<{ name: string; message: string }>;
}

/** Loads packages through the target worktree's resolver, never through a
 * shell command. This verifies a native binding with the same resolution a
 * process started in that worktree would use. */
export function verifyNativeDependencies(worktreeRoot: string, packageNames: string[]): NativeDependencyVerification {
  const requireFromWorktree = createRequire(join(worktreeRoot, "package.json"));
  const failures: Array<{ name: string; message: string }> = [];

  for (const name of packageNames) {
    try {
      requireFromWorktree(name);
    } catch (error: any) {
      failures.push({ name, message: error?.message ?? String(error) });
    }
  }

  return { ok: failures.length === 0, failures };
}
