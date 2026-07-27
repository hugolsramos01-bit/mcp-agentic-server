import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCodeRegions } from "../dist/change-intelligence/code-regions.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const cwd = join(__dirname, "..");

const filesToTest = [
  "src/server.ts",
  "src/change-intelligence/task-context.ts",
  "src/assistant-tools.ts",
  "src/pi-tools.ts"
];

console.log("Starting Code Regions Perf Test...\n");

let totalTimeRaw = 0;
for (const file of filesToTest) {
  const fullPath = join(cwd, file);
  const content = readFileSync(fullPath, "utf8");
  
  const start = performance.now();
  const regions = extractCodeRegions(fullPath, content, {});
  const end = performance.now();
  
  const elapsed = end - start;
  totalTimeRaw += elapsed;
  
  console.log(`[RAW] ${file}: ${regions.length} regions extracted in ${elapsed.toFixed(2)}ms`);
}
console.log(`\nTotal RAW extraction time: ${totalTimeRaw.toFixed(2)}ms\n`);
