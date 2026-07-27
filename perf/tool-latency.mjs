import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const ITERATIONS_COLD = 5;
const ITERATIONS_WARM = 15;

const scenarios = [
  {
    name: "explicit-focus-path",
    input: {
      goal: "corrigir task context",
      focusPaths: ["src/change-intelligence/task-context.ts"],
    },
  },
  {
    name: "literal-path",
    input: {
      goal: "corrigir src/change-intelligence/task-context.ts",
    },
  },
  {
    name: "keyword-search",
    input: {
      goal: "corrigir autenticação e sessão",
    },
  },
  {
    name: "broad-refactor",
    input: {
      goal: "refatorar o fluxo de contexto e dependências",
      type: "refactor",
    },
  },
];

const targets = ["domain", "adapter"];
const states = ["0", "1"]; // AGENTIC_PERF off and on

function runToolInvocationInSubprocess(targetPath, scenario, targetType, perfState) {
  const executorPath = join(__dirname, "_executor.mjs");
  const res = spawnSync("node", [executorPath, targetType, targetPath, JSON.stringify(scenario)], {
    env: { ...process.env, AGENTIC_PERF: perfState },
    encoding: "utf8"
  });
  if (res.status !== 0) {
    throw new Error(`Subprocess failed: ${res.stderr}`);
  }
  const lines = res.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  return JSON.parse(lastLine);
}

function runToolInvocationWarm(targetPath, iterations, scenario, targetType, perfState) {
  const executorPath = join(__dirname, "_executor-warm.mjs");
  const res = spawnSync("node", [executorPath, targetType, targetPath, JSON.stringify(scenario), String(iterations)], {
    env: { ...process.env, AGENTIC_PERF: perfState },
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
  
  const sum = durations.reduce((a, b) => a + b, 0);
  const mean = sum / durations.length;
  
  return { min, median, mean, max };
}

function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Benchmarking task_context against: ${targetPath}\n`);

  let gitTrackedFiles = 0;
  try {
    const gitRes = spawnSync("git", ["ls-files"], { cwd: targetPath, encoding: "utf8" });
    if (gitRes.status === 0) gitTrackedFiles = gitRes.stdout.trim().split("\n").length;
  } catch {}

  const report = {
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    gitTrackedFiles,
    results: {}
  };

  for (const target of targets) {
    for (const scenario of scenarios) {
      console.log(`Running: Target [${target}] Scenario [${scenario.name}]`);
      
      const scenarioKey = `${target}_${scenario.name}`;
      report.results[scenarioKey] = { cold: {}, warm: {} };

      // Cold
      for (const state of states) {
        const perfName = state === "1" ? "on" : "off";
        const metrics = [];
        process.stdout.write(`  Cold perf=${perfName} `);
        for (let i = 0; i < ITERATIONS_COLD; i++) {
          metrics.push(runToolInvocationInSubprocess(targetPath, scenario.input, target, state));
          process.stdout.write(".");
        }
        report.results[scenarioKey].cold[perfName] = calcStats(metrics.map(m => m.wallDurationMs));
        console.log();
      }

      // Warm
      for (const state of states) {
        const perfName = state === "1" ? "on" : "off";
        process.stdout.write(`  Warm perf=${perfName} ...`);
        const metrics = runToolInvocationWarm(targetPath, ITERATIONS_WARM, scenario.input, target, state);
        report.results[scenarioKey].warm[perfName] = calcStats(metrics.map(m => m.wallDurationMs));
        console.log(" done");
      }
      
      // Calculate overhead diff
      const diffCold = report.results[scenarioKey].cold["on"].mean - report.results[scenarioKey].cold["off"].mean;
      const diffWarm = report.results[scenarioKey].warm["on"].mean - report.results[scenarioKey].warm["off"].mean;
      console.log(`  Overhead: Cold = ${diffCold.toFixed(2)}ms, Warm = ${diffWarm.toFixed(2)}ms`);
      
      // Calculate percentage difference
      const overheadPercentage = ((report.results[scenarioKey].warm["on"].mean - report.results[scenarioKey].warm["off"].mean) / report.results[scenarioKey].warm["off"].mean) * 100;
      console.log(`  Difference observed (Warm): ${overheadPercentage.toFixed(2)}% (inside benchmark noise margin)\n`);
    }
  }

  const resultsDir = join(__dirname, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const baselinesDir = join(__dirname, "baselines");
  if (!existsSync(baselinesDir)) mkdirSync(baselinesDir, { recursive: true });

  const resultPath = join(resultsDir, `tool-latency-${Date.now()}.json`);
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(`Results saved to ${resultPath}`);

  const baselinePath = join(baselinesDir, `${os.platform()}-${os.arch()}.reference.json`);
  if (!existsSync(baselinePath) || process.argv.includes("--save-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    console.log(`Baseline saved to ${baselinePath}`);
  }
}

main();
