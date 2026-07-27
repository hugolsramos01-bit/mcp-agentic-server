/**
 * perf/code-regions.mjs
 *
 * Benchmarks for the P3 code region extraction pipeline:
 *   1. Raw AST extraction (cold, no cache)
 *   2. Cache miss path (first call per file)
 *   3. Cache hit path (warm, subsequent call same goal)
 *   4. Different-goal path (re-ranks from raw index)
 *
 * Usage:
 *   npm run bench:regions
 */

import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = join(__dirname, "..");
const distDir = join(cwd, "dist");

// ── Load dist modules ──────────────────────────────────────────────────
const { extractCodeRegions } = await import(
  pathToFileURL(join(distDir, "change-intelligence/code-regions.js")).href
);
const { loadAndExtractCodeRegions, clearCodeRegionCache } = await import(
  pathToFileURL(join(distDir, "change-intelligence/code-region-cache.js")).href
);

// ── Files to test ─────────────────────────────────────────────────────
const filesToTest = [
  "src/server.ts",
  "src/change-intelligence/task-context.ts",
  "src/assistant-tools.ts",
  "src/pi-tools.ts",
];

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function bench(label, fn, iterations = 10) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const mean = avg(times);
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`  ${label.padEnd(55)} mean=${mean.toFixed(2)}ms  min=${min.toFixed(2)}ms  max=${max.toFixed(2)}ms`);
  return mean;
}

// ── 1. Raw AST extraction (no cache) ──────────────────────────────────
console.log("\n=== 1. Raw AST extraction (single pass per file) ===\n");
let totalRaw = 0;
for (const file of filesToTest) {
  const fullPath = join(cwd, file);
  const content = readFileSync(fullPath, "utf8");
  let regionCount = 0;
  const mean = bench(file, () => {
    const regions = extractCodeRegions(fullPath, content, {});
    regionCount = regions.length;
  });
  console.log(`    → ${regionCount} regions`);
  totalRaw += mean;
}
console.log(`\n  Total mean across all files: ${totalRaw.toFixed(2)}ms`);

// ── 2 & 3. Cache miss vs warm hit ─────────────────────────────────────
console.log("\n=== 2. Cache miss vs warm hit (loadAndExtractCodeRegions) ===\n");

const TMP = join(tmpdir(), `bench-regions-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const SAMPLE = filesToTest[1]; // task-context.ts — a representative medium file
const sampleFull = join(cwd, SAMPLE);
const sampleContent = readFileSync(sampleFull, "utf8");
writeFileSync(join(TMP, "sample.ts"), sampleContent, "utf8");

const KEYWORDS = ["authenticate", "budget", "candidate"];

// Cold (cache miss)
clearCodeRegionCache();
const coldTimes = [];
for (let i = 0; i < 8; i++) {
  clearCodeRegionCache();
  const t0 = performance.now();
  await loadAndExtractCodeRegions({
    workspaceRoot: TMP,
    path: "sample.ts",
    anchorKeywords: KEYWORDS,
    maxRegions: 8,
  });
  coldTimes.push(performance.now() - t0);
}
console.log(`  Cache miss (cold): mean=${avg(coldTimes).toFixed(2)}ms  min=${Math.min(...coldTimes).toFixed(2)}ms  max=${Math.max(...coldTimes).toFixed(2)}ms`);

// Warm (cache hit — same goal)
clearCodeRegionCache();
// Prime the cache
await loadAndExtractCodeRegions({
  workspaceRoot: TMP,
  path: "sample.ts",
  anchorKeywords: KEYWORDS,
  maxRegions: 8,
});
const warmTimes = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  await loadAndExtractCodeRegions({
    workspaceRoot: TMP,
    path: "sample.ts",
    anchorKeywords: KEYWORDS,
    maxRegions: 8,
  });
  warmTimes.push(performance.now() - t0);
}
console.log(`  Cache hit  (warm): mean=${avg(warmTimes).toFixed(2)}ms  min=${Math.min(...warmTimes).toFixed(4)}ms  max=${Math.max(...warmTimes).toFixed(2)}ms`);
console.log(`  Speedup factor:    ${(avg(coldTimes) / avg(warmTimes)).toFixed(1)}×`);

// Different goal (re-ranks from raw index)
const altKeywords = ["paginate", "cursor", "offset"];
const altTimes = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await loadAndExtractCodeRegions({
    workspaceRoot: TMP,
    path: "sample.ts",
    anchorKeywords: altKeywords,
    maxRegions: 4,
  });
  altTimes.push(performance.now() - t0);
}
console.log(`  Different goal:    mean=${avg(altTimes).toFixed(2)}ms  (re-ranks from raw index, no extra read)`);

// ── 4. Read deduplication: 5 regions, 1 read ─────────────────────────
console.log("\n=== 3. read_many dedup: 5 regions of same file = 1 stat + 1 read ===\n");
const { readManyTool } = await import(
  pathToFileURL(join(distDir, "assistant-tools.js")).href
);
const FILE_PATH = SAMPLE;

const dedupTimes = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await readManyTool({
    items: [
      { path: FILE_PATH, startLine: 1, endLine: 20 },
      { path: FILE_PATH, startLine: 50, endLine: 80 },
      { path: FILE_PATH, startLine: 100, endLine: 130 },
      { path: FILE_PATH, startLine: 200, endLine: 230 },
      { path: FILE_PATH, startLine: 300, endLine: 330 },
    ],
  }, cwd, [cwd]);
  dedupTimes.push(performance.now() - t0);
}
console.log(`  5 regions of ${FILE_PATH}`);
console.log(`  mean=${avg(dedupTimes).toFixed(2)}ms  min=${Math.min(...dedupTimes).toFixed(2)}ms  max=${Math.max(...dedupTimes).toFixed(2)}ms`);

console.log("\n=== Done ===\n");
