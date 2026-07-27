import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const ITERATIONS_COLD = 10;
const ITERATIONS_WARM = 30;

function runToolInvocationInSubprocess(targetPath) {
  // We use another script to do the actual invocation and print JSON to stdout
  const executorPath = join(__dirname, "_executor.mjs");
  const res = spawnSync("node", [executorPath, "task_context", targetPath], {
    env: { ...process.env, AGENTIC_PERF: "1" },
    encoding: "utf8"
  });
  if (res.status !== 0) {
    throw new Error(`Subprocess failed: ${res.stderr}`);
  }
  // The executor should print the JSON metrics to stdout as the last line
  const lines = res.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  return JSON.parse(lastLine);
}

function runToolInvocationWarm(targetPath, iterations) {
  const executorPath = join(__dirname, "_executor-warm.mjs");
  const res = spawnSync("node", [executorPath, "task_context", targetPath, String(iterations)], {
    env: { ...process.env, AGENTIC_PERF: "1" },
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error(`Subprocess failed: ${res.stderr}`);
  }
  const lines = res.stdout.trim().split("\n");
  const metrics = [];
  for (const line of lines) {
    if (line.startsWith("{")) {
      metrics.push(JSON.parse(line));
    }
  }
  return metrics;
}

function calcStats(durations) {
  durations.sort((a, b) => a - b);
  const min = durations[0];
  const max = durations[durations.length - 1];
  const median = durations[Math.floor(durations.length / 2)];
  const p90 = durations[Math.floor(durations.length * 0.90)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  
  const sum = durations.reduce((a, b) => a + b, 0);
  const mean = sum / durations.length;
  const variance = durations.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / durations.length;
  const stdDev = Math.sqrt(variance);
  
  return { min, median, p90, p95, max, stdDev, mean };
}

function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Benchmarking task_context against: ${targetPath}`);

  // Get total files for reporting
  let gitTrackedFiles = 0;
  try {
    const gitRes = spawnSync("git", ["ls-files"], { cwd: targetPath, encoding: "utf8" });
    if (gitRes.status === 0) gitTrackedFiles = gitRes.stdout.trim().split("\n").length;
  } catch {}

  console.log(`\nRunning COLD boots (${ITERATIONS_COLD} iterations)...`);
  const coldMetrics = [];
  for (let i = 0; i < ITERATIONS_COLD; i++) {
    coldMetrics.push(runToolInvocationInSubprocess(targetPath));
    process.stdout.write(".");
  }
  console.log("\nCOLD runs complete.");

  console.log(`\nRunning WARM boots (${ITERATIONS_WARM} iterations)...`);
  const warmMetrics = runToolInvocationWarm(targetPath, ITERATIONS_WARM);
  console.log("WARM runs complete.");

  const coldDurations = coldMetrics.map(m => m.durationMs);
  const warmDurations = warmMetrics.map(m => m.durationMs);

  const report = {
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpu: os.cpus()[0]?.model || "unknown",
    gitTrackedFiles,
    scenario: "task_context_default",
    cold: calcStats(coldDurations),
    warm: calcStats(warmDurations),
  };

  const resultsDir = join(__dirname, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const baselinesDir = join(__dirname, "baselines");
  if (!existsSync(baselinesDir)) mkdirSync(baselinesDir, { recursive: true });

  const resultPath = join(resultsDir, `tool-latency-${Date.now()}.json`);
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to ${resultPath}`);

  const baselinePath = join(baselinesDir, `${os.platform()}-${os.arch()}.reference.json`);
  if (!existsSync(baselinePath) || process.argv.includes("--save-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    console.log(`Baseline saved to ${baselinePath}`);
  }

  console.log("\n--- COLD STATS (ms) ---");
  console.table(report.cold);
  console.log("\n--- WARM STATS (ms) ---");
  console.table(report.warm);
}

main();
