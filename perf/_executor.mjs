import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const taskContextPath = join(__dirname, "../dist/change-intelligence/task-context.js");
const perfRecorderPath = join(__dirname, "../dist/performance/performance-recorder.js");

if (!fs.existsSync(taskContextPath)) {
  console.error("Error: dist/ not found. Run 'npm run build' before benchmarking.");
  process.exit(1);
}

const { buildTaskContext, taskContextTool } = await import(pathToFileURL(taskContextPath).href);
const { startToolPerformance } = await import(pathToFileURL(perfRecorderPath).href);

async function main() {
  const targetType = process.argv[2] || "domain";
  const targetPath = process.argv[3] || process.cwd();
  const inputStr = process.argv[4];
  const input = inputStr ? JSON.parse(inputStr) : { goal: "test authentication login module" };
  
  const perf = startToolPerformance("task_context");
  
  const startedAt = performance.now();
  
  if (targetType === "domain") {
    await buildTaskContext({
      cwd: targetPath,
      allowedRoots: [targetPath],
      ...input,
      perf
    });
  } else if (targetType === "adapter") {
    await taskContextTool(
      targetPath,
      [targetPath],
      input,
      perf
    );
  }
  
  const wallDurationMs = performance.now() - startedAt;
  perf.finish(); // Not currently serializing wrapped result inside the executor script since it's meant for internal timing check, but the adapter itself does some serialization.
  
  console.log(JSON.stringify({
    wallDurationMs,
    perfEnabled: process.env.AGENTIC_PERF === "1",
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
