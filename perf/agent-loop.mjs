import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const targetPath = process.argv[2] || process.cwd();

console.log(`Synthetic Agent Workflow Benchmark`);
console.log(`Target: ${targetPath}`);
console.log(`(This measures local tool latency chaining, not model inference)`);

// The executor will run multiple tools in a single process
const executorPath = join(__dirname, "_executor-synthetic-workflow.mjs");

const ITERATIONS = 10;
const results = [];

console.log(`\nRunning ${ITERATIONS} iterations of full synthetic workflow...`);
for (let i = 0; i < ITERATIONS; i++) {
  const res = spawnSync("node", [executorPath, targetPath], {
    env: { ...process.env, AGENTIC_PERF: "1" },
    encoding: "utf8"
  });
  if (res.status !== 0) {
    console.error(`Subprocess failed: ${res.stderr}`);
    process.exit(1);
  }
  const lines = res.stdout.trim().split("\n");
  const metrics = JSON.parse(lines[lines.length - 1]);
  results.push(metrics);
  process.stdout.write(".");
}
console.log("\nComplete.");

const durations = results.map(r => r.totalDurationMs).sort((a, b) => a - b);
const min = durations[0];
const max = durations[durations.length - 1];
const median = durations[Math.floor(durations.length / 2)];
const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

console.log("\n--- SYNTHETIC WORKFLOW STATS (ms) ---");
console.table({ min, median, mean, max });
