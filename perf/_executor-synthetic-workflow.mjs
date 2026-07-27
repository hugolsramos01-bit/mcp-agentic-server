import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const taskContextPath = join(__dirname, "../dist/change-intelligence/task-context.js");
const assistantToolsPath = join(__dirname, "../dist/assistant-tools.js");
const bootstrapToolsPath = join(__dirname, "../dist/bootstrap-tools.js");

if (!fs.existsSync(taskContextPath)) {
  console.error("Error: dist/ not found. Run 'npm run build' before benchmarking.");
  process.exit(1);
}

const { taskContextTool } = await import(pathToFileURL(taskContextPath).href);
const { readManyTool } = await import(pathToFileURL(assistantToolsPath).href);
const { suggestChecksTool } = await import(pathToFileURL(bootstrapToolsPath).href);

if (typeof readManyTool !== "function") {
  throw new Error("readManyTool is unavailable in the compiled build");
}

if (typeof suggestChecksTool !== "function") {
  throw new Error("suggestChecksTool is unavailable in the compiled build");
}

async function main() {
  const targetPath = process.argv[2] || process.cwd();
  
  const steps = {};
  let startedAt = performance.now();
  
  // 1. task_context
  const taskContextRes = await taskContextTool(targetPath, [targetPath], {
    goal: "inspect task context performance",
    type: "auto",
    focusPaths: ["src/change-intelligence/task-context.ts"],
  });
  steps.taskContextMs = performance.now() - startedAt;
  
  const result = taskContextRes.structuredContent;
  
  const paths = (result.primaryFiles || [])
    .slice(0, 3)
    .map(file => file.path);
    
  if (paths.length === 0) {
    throw new Error("Synthetic workflow produced no primary files");
  }

  // 2. read_many
  startedAt = performance.now();
  await readManyTool(
    { paths, compressionLevel: "balanced", maxTokens: 6000 },
    targetPath,
    [targetPath]
  );
  steps.readManyMs = performance.now() - startedAt;

  // 3. suggest_checks
  startedAt = performance.now();
  await suggestChecksTool(targetPath, {
    paths,
    scope: "changed",
    level: "minimal",
  });
  steps.suggestChecksMs = performance.now() - startedAt;
  
  const totalDurationMs = steps.taskContextMs + steps.readManyMs + steps.suggestChecksMs;
  
  console.log(JSON.stringify({
    totalDurationMs,
    steps,
    executed: {
      taskContext: true,
      readMany: true,
      suggestChecks: true,
    },
    primaryFileCount: paths.length,
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
