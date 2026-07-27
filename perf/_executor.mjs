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
  const tool = process.argv[2] || "task_context";
  const targetPath = process.argv[3] || process.cwd();
  
  const perf = startToolPerformance(tool);
  await buildTaskContext({
    cwd: targetPath,
    allowedRoots: [targetPath],
    goal: "test authentication login module",
    perf
  });
  
  const metrics = perf.finish();
  console.log(JSON.stringify(metrics));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
