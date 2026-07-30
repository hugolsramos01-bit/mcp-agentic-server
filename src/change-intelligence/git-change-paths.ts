import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getGitChangedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all"
      ],
      {
        cwd,
        encoding: "buffer"
      }
    );
    const changedPaths: string[] = [];
    let i = 0;
    while (i < stdout.length) {
      if (i + 2 >= stdout.length) break;

      // Porcelain v1 format: XY PATH\0 or XY PATH\0ORIG_PATH\0 for renames
      const x = stdout[i];
      const y = stdout[i + 1];
      const status = String.fromCharCode(x, y);
      
      // Skip the space after XY
      let start = i + 3;
      let end = start;
      while (end < stdout.length && stdout[end] !== 0) {
        end++;
      }

      if (end >= stdout.length) break;

      let filePath = stdout.subarray(start, end).toString("utf8");

      // Handle renames/copies (R or C in X or Y)
      if (x === 0x52 /* R */ || x === 0x43 /* C */ || y === 0x52 || y === 0x43) {
        // The first path is the NEW path, which is what we care about
        // The ORIG_PATH follows the next null byte
        i = end + 1;
        let origEnd = i;
        while (origEnd < stdout.length && stdout[origEnd] !== 0) {
          origEnd++;
        }
        end = origEnd;
      }

      // Normalize windows separators if any, though git status usually gives forward slashes
      filePath = filePath.replace(/\\/g, "/");

      if (filePath) {
        changedPaths.push(filePath);
      }

      i = end + 1;
    }

    return changedPaths;
  } catch (error) {
    throw new Error("Failed to get git changed paths");
  }
}
