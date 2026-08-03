import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function findGitMetadataRoot(cwd: string): string | null {
  const workspaceRoot = resolve(cwd);
  return existsSync(join(workspaceRoot, ".git")) ? workspaceRoot : null;
}

export async function getGitChangedPaths(cwd: string): Promise<string[]> {
  if (!findGitMetadataRoot(cwd)) {
    const error = new Error("Git metadata unavailable");
    (error as Error & { code?: string }).code = "git_metadata_unavailable";
    throw error;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      {
        cwd,
        encoding: "buffer",
      },
    );
    const changedPaths: string[] = [];
    let i = 0;
    while (i < stdout.length) {
      if (i + 2 >= stdout.length) break;

      const x = stdout[i];
      const y = stdout[i + 1];

      let start = i + 3;
      let end = start;
      while (end < stdout.length && stdout[end] !== 0) {
        end++;
      }

      if (end >= stdout.length) break;

      let filePath = stdout.subarray(start, end).toString("utf8");

      if (
        x === 0x52 ||
        x === 0x43 ||
        y === 0x52 ||
        y === 0x43
      ) {
        i = end + 1;
        let origEnd = i;
        while (origEnd < stdout.length && stdout[origEnd] !== 0) {
          origEnd++;
        }
        end = origEnd;
      }

      filePath = filePath.replace(/\\/g, "/");

      if (filePath) {
        changedPaths.push(filePath);
      }

      i = end + 1;
    }

    return changedPaths;
  } catch (cause) {
    throw new Error("Failed to get git changed paths", { cause });
  }
}
