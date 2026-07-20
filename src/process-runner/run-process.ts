import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveExecutable } from "./resolve-executable.js";
import type { ProcessResult, ProcessRunnerOptions, ProcessTermination } from "./types.js";

const MAX_CAPTURED_OUTPUT = 5 * 1024 * 1024;

/** Runs a process multi-platform securely with shell: false. */
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
    return infrastructureError(rawExecutable, args, options.cwd, err, startTime);
  }

  if (options.signal?.aborted) {
    return { status: "cancelled", executable, args, cwd: options.cwd, stdout: "", stderr: "", durationMs: Date.now() - startTime, termination: { requested: true, method: "process", confirmed: true } };
  }

  return new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopReason: "timeout" | "cancelled" | undefined;
    let terminationPromise: Promise<ProcessTermination> | undefined;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const beginTermination = (reason: "timeout" | "cancelled") => {
      if (stopReason) return;
      stopReason = reason;
      terminationPromise = terminateProcessTree(child);
    };
    const onAbort = () => beginTermination("cancelled");

    try {
      let spawnExe = executable;
      let spawnArgs = args;
      if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
        const entrypoint = findWindowsNodeEntrypoint(executable);
        if (!entrypoint) {
          finish({ status: "infrastructure_error", executable, args, cwd: options.cwd, message: `Could not resolve a Node entrypoint for ${executable}; refusing to invoke cmd.exe.`, durationMs: Date.now() - startTime });
          return;
        }
        spawnExe = process.execPath;
        spawnArgs = [entrypoint, ...args];
      }
      child = spawn(spawnExe, spawnArgs, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsVerbatimArguments: false,
        // A separate POSIX process group lets timeout/cancellation include descendants.
        detached: process.platform !== "win32",
      });
    } catch (err: any) {
      finish(infrastructureError(executable, args, options.cwd, err, startTime));
      return;
    }

    timer = setTimeout(() => beginTermination("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk.toString(), "stdout"); });
    child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk.toString(), "stderr"); });

    child.on("error", (err: any) => finish(infrastructureError(executable, args, options.cwd, err, startTime)));
    child.on("close", async (code) => {
      const durationMs = Date.now() - startTime;
      if (stopReason) {
        const termination = await (terminationPromise ?? Promise.resolve({ requested: true, method: "process" as const, confirmed: false }));
        finish(stopReason === "timeout"
          ? { status: "timeout", executable, args, cwd: options.cwd, timeoutMs, stdout, stderr, durationMs, pid: child.pid, termination }
          : { status: "cancelled", executable, args, cwd: options.cwd, stdout, stderr, durationMs, pid: child.pid, termination });
        return;
      }
      finish(code === 0
        ? { status: "success", executable, args, cwd: options.cwd, exitCode: 0, stdout, stderr, durationMs }
        : { status: "command_failed", executable, args, cwd: options.cwd, exitCode: code ?? -1, stdout, stderr, durationMs });
    });
  });
}

function infrastructureError(executable: string, args: string[], cwd: string, err: any, startTime: number): ProcessResult {
  return { status: "infrastructure_error", executable, args, cwd, code: err?.code, message: err?.message ?? String(err), durationMs: Date.now() - startTime };
}

function appendOutput(current: string, next: string, stream: "stdout" | "stderr"): string {
  if (current.length >= MAX_CAPTURED_OUTPUT) return current;
  const combined = current + next;
  return combined.length > MAX_CAPTURED_OUTPUT
    ? combined.slice(0, MAX_CAPTURED_OUTPUT) + `\n[... ${stream} truncated ...]`
    : combined;
}

async function terminateProcessTree(child: ChildProcess): Promise<ProcessTermination> {
  if (!child.pid) return { requested: true, method: "process", confirmed: false };
  if (process.platform === "win32") {
    const confirmed = await new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
      killer.once("error", () => resolve(false));
      killer.once("close", (code) => resolve(code === 0));
    });
    return { requested: true, method: "taskkill", confirmed };
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    // POSIX has no portable synchronous tree-kill acknowledgement. The caller
    // still receives the close event before the result is returned.
    return { requested: true, method: "process_group", confirmed: false };
  } catch {
    return { requested: true, method: "process", confirmed: child.kill("SIGKILL") };
  }
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
      for (const pattern of [/%~dp0\\([^"'\r\n]+?\.(?:c?js|mjs))/gi, /%dp0%\\([^"'\r\n]+?\.(?:c?js|mjs))/gi]) {
        const match = [...source.matchAll(pattern)].at(-1);
        if (!match) continue;
        const entrypoint = join(dirname(candidate), match[1].replace(/\\/g, "/"));
        if (existsSync(entrypoint)) return entrypoint;
      }
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}
