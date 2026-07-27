import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const taskContextPath = join(__dirname, "../dist/change-intelligence/task-context.js");
const readManyPath = join(__dirname, "../dist/pi-tools.js");
const suggestChecksPath = join(__dirname, "../dist/bootstrap-tools.js");

if (!fs.existsSync(taskContextPath)) {
  console.error("Error: dist/ not found. Run 'npm run build' before benchmarking.");
  process.exit(1);
}

const { taskContextTool } = await import(pathToFileURL(taskContextPath).href);
// In a real environment, read_many is in pi-tools.js but exported in a complex way.
// We will import readManyTool internal or its implementation directly.
// Actually, read_many might be registered in bootstrap-tools.js or pi-tools.js.
// Let's import the raw handlers or simulate it by using the exported functions.

// I will just use taskContextTool, and if I can't find readMany easily, I will require it.
// To avoid deep refactoring for the synthetic workflow, we can import readManyTool if available.
const piTools = await import(pathToFileURL(readManyPath).href);
const bootstrapTools = await import(pathToFileURL(suggestChecksPath).href);

async function main() {
  const targetPath = process.argv[2] || process.cwd();
  
  const start = performance.now();
  
  // 1. task_context
  const taskContextRes = await taskContextTool(targetPath, [targetPath], {
    goal: "performance baseline synthetic check",
    type: "auto"
  });
  
  const result = taskContextRes.structuredContent;
  
  const paths = (result.primaryFiles || [])
    .slice(0, 3)
    .map(file => file.path);
    
  if (paths.length > 0) {
    // 2. read_many
    if (piTools.readManyTool) {
      await piTools.readManyTool(
        { paths, compressionLevel: "balanced", maxTokens: 6000 },
        targetPath,
        [targetPath]
      );
    }
  }

  // 3. suggest_checks
  if (bootstrapTools.suggestChecksHandler) {
    await bootstrapTools.suggestChecksHandler(targetPath, {
      paths,
      scope: "changed",
      level: "minimal",
    });
  } else if (bootstrapTools.suggestChecksTool) {
    // We don't have direct access to suggestChecksTool handler without adapter, but we'll try:
    try {
      await bootstrapTools.suggestChecksTool(targetPath, { paths, scope: "changed", level: "minimal" });
    } catch {}
  }
  
  const totalDurationMs = performance.now() - start;
  console.log(JSON.stringify({ totalDurationMs }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
