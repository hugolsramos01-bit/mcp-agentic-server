import { runProcess } from "./process-runner/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function agenticDoctor(cwd = process.cwd()) {
  const probe = async (executable: string) => {
    const result = await runProcess(executable, ["--version"], { cwd, timeoutMs: 10_000 });
    return { status: result.status, value: result.status === "success" ? result.stdout.trim() : ("message" in result ? result.message : result.stderr.trim()) };
  };
  let version = "unknown";
  try { version = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? version; } catch { /* unavailable in a packaged runtime */ }
  const git = await runProcess("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutMs: 10_000 });
  return {
    version,
    gitCommit: git.status === "success" ? git.stdout.trim() : undefined,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    executable: process.execPath,
    workingDirectory: cwd,
    packageManagers: { npm: await probe("npm"), pnpm: await probe("pnpm"), yarn: await probe("yarn") },
    processRunner: await probe(process.execPath),
  };
}
