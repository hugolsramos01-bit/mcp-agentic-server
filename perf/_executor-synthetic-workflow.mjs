import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const { pathToFileURL } = await import("node:url");

const taskContextPath = join(__dirname, "../dist/change-intelligence/task-context.js");
const perfRecorderPath = join(__dirname, "../dist/performance/performance-recorder.js");

if (!fs.existsSync(taskContextPath)) {
  console.error("Error: dist/ not found. Run 'npm run build' before benchmarking.");
  process.exit(1);
}

const { buildTaskContext } = await import(pathToFileURL(taskContextPath).href);
const { startToolPerformance } = await import(pathToFileURL(perfRecorderPath).href);

async function main() {
  const targetPath = process.argv[2] || process.cwd();
  
  const start = performance.now();
  
  // Fake "open_workspace" (no-op here since it's just initializing state in reality)
  
  // 1. task_context
  const perfTc = startToolPerformance("task_context");
  await buildTaskContext({
    cwd: targetPath,
    allowedRoots: [targetPath],
    goal: "performance baseline synthetic check",
    perf: perfTc
  });
  perfTc.finish();
  
  // More tools could be imported here (e.g., read_many, suggest_checks)
  // For the baseline, we simulate by adding small delays if we don't have them imported easily,
  // or just run task_context again with a different goal to simulate a follow-up.
  
  const totalDurationMs = performance.now() - start;
  console.log(JSON.stringify({ totalDurationMs }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
