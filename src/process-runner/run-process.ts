import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveExecutable } from "./resolve-executable.js";
import type { ProcessResult, ProcessRunnerOptions } from "./types.js";

/**
 * Runs a process multi-platform securely with shell: false.
 */
export async function runProcess(
  rawExecutable: string,
  args: string[],
  options: ProcessRunnerOptions
): Promise<ProcessResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  
  let executable: string;
  try {
    executable = await resolveExecutable(rawExecutable, options.cwd);
  } catch (err: any) {
    return {
      status: "infrastructure_error",
      executable: rawExecutable,
      args,
      cwd: options.cwd,
      message: `Failed to resolve executable: ${err.message}`,
      durationMs: Date.now() - startTime,
    };
  }

  return new Promise<ProcessResult>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";

    let child;
    try {
      let spawnExe = executable;
      let spawnArgs = args;
      if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
        const entrypoint = findWindowsNodeEntrypoint(executable);
        if (!entrypoint) {
          return resolve({
            status: "infrastructure_error", executable, args, cwd: options.cwd,
            message: `Could not resolve a Node entrypoint for ${executable}; refusing to invoke cmd.exe.`,
            durationMs: Date.now() - startTime,
          });
        }
        spawnExe = process.execPath;
        spawnArgs = [entrypoint, ...args];
      }

      child = spawn(spawnExe, spawnArgs, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsVerbatimArguments: false,
      });
    } catch (err: any) {
      return resolve({
        status: "infrastructure_error",
        executable,
        args,
        cwd: options.cwd,
        code: err.code,
        message: err.message,
        durationMs: Date.now() - startTime,
      });
    }

    let isTimeout = false;
    const timer = setTimeout(() => {
      isTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        // Prevent unbounded memory growth in case of massive outputs
        if (stdoutBuf.length > 5 * 1024 * 1024) {
          stdoutBuf = stdoutBuf.slice(0, 5 * 1024 * 1024) + "\n[... stdout truncated ...]";
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 5 * 1024 * 1024) {
          stderrBuf = stderrBuf.slice(0, 5 * 1024 * 1024) + "\n[... stderr truncated ...]";
        }
      });
    }

    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({
        status: "infrastructure_error",
        executable,
        args,
        cwd: options.cwd,
        code: err.code,
        message: err.message,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (isTimeout) {
        return resolve({
          status: "timeout",
          executable,
          args,
          cwd: options.cwd,
          timeoutMs,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          durationMs,
        });
      }

      if (code === 0) {
        resolve({
          status: "success",
          executable,
          args,
          cwd: options.cwd,
          exitCode: 0,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          durationMs,
        });
      } else {
        // Includes non-zero exits or killed by signal (code null)
        resolve({
          status: "command_failed",
          executable,
          args,
          cwd: options.cwd,
          exitCode: code ?? -1,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          durationMs,
        });
      }
    });
  });
}

/** Batch shims installed by npm, pnpm and yarn contain the path to their Node
 * CLI. Execute that CLI directly instead of running cmd.exe /c. */
function findWindowsNodeEntrypoint(executable: string): string | undefined {
  const candidates = executable.includes("\\") || executable.includes("/")
    ? [executable]
    : (process.env.PATH ?? "").split(";").map((part) => join(part, executable));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const source = readFileSync(candidate, "utf8");
      const patterns = [
        /%~dp0\\([^"'\r\n]+?\.(?:c?js|mjs))/gi,
        /%dp0%\\([^"'\r\n]+?\.(?:c?js|mjs))/gi,
      ];
      for (const pattern of patterns) {
        const match = [...source.matchAll(pattern)].at(-1);
        if (!match) continue;
        const entrypoint = join(dirname(candidate), match[1].replace(/\\/g, "/"));
        if (existsSync(entrypoint)) return entrypoint;
      }
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}
