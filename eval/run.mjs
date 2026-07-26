#!/usr/bin/env node
/**
 * eval/run.mjs — Agentic MCP agent eval runner
 *
 * Usage:
 *   node eval/run.mjs                       # assert against snapshots
 *   node eval/run.mjs --update              # overwrite snapshots with current output
 *   node eval/run.mjs --suite suggest_checks # run only one suite
 *   node eval/run.mjs --update --suite read  # update only one suite
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { structuralDiff, formatDiffs } from "./lib/diff.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const CASES_DIR = join(__dirname, "cases");
const DIST = join(ROOT, "dist");

// ─── CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const suiteFilter = (() => {
  const idx = args.indexOf("--suite");
  return idx !== -1 ? args[idx + 1] : null;
})();

// ─── Suite registry ──────────────────────────────────────────
// Each suite exports: { name, run(input, cwd) => Promise<any> }
// Input comes from <case>.input.json; snapshot from <case>.snap.json.

const SUITES = {
  suggest_checks: async (input, cwd) => {
    const { suggestChecksTool } = await import(pathToFileURL(join(DIST, "bootstrap-tools.js")).href);
    const result = await suggestChecksTool(cwd, input);
    return parseToolResponse(result);
  },

  read: async (input, cwd) => {
    // readFileTool takes (input: ReadToolInput, context: ToolContext)
    const { readFileTool } = await import(pathToFileURL(join(DIST, "pi-tools.js")).href);
    const result = await readFileTool(
      { path: input.path },
      { cwd, root: cwd, readRoots: [cwd] }
    );
    return parseToolResponse(result);
  },

  read_many: async (input, cwd) => {
    const { readManyTool } = await import(pathToFileURL(join(DIST, "assistant-tools.js")).href);
    const result = await readManyTool(
      { paths: input.paths, compressionLevel: input.compressionLevel },
      cwd,
      [cwd]
    );
    return parseToolResponse(result);
  },

  semantic_pack: async (input, cwd) => {
    const { semanticPackTool } = await import(pathToFileURL(join(DIST, "semantic-tools.js")).href);
    // semanticPackTool(cwd, allowedRoots, input)
    const result = await semanticPackTool(cwd, [cwd], { goal: input.goal });
    return parseToolResponse(result);
  },

  grep: async (input, cwd) => {
    const { grepFilesTool } = await import(pathToFileURL(join(DIST, "pi-tools.js")).href);
    // grepFilesTool takes (input: GrepToolInput, context: ToolContext)
    const result = await grepFilesTool(
      { pattern: input.pattern, path: input.path ?? ".", glob: input.glob },
      { cwd, root: cwd, readRoots: [cwd] }
    );
    return parseToolResponse(result);
  },
};

// ─── Helpers ─────────────────────────────────────────────────

function parseToolResponse(result) {
  if (!result || !result.content) return result;
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { _rawText: text };
  }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function listCases(suite) {
  const dir = join(CASES_DIR, suite);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".input.json"))
    .map((f) => ({
      name: basename(f, ".input.json"),
      inputPath: join(dir, f),
      snapPath: join(dir, f.replace(".input.json", ".snap.json")),
    }));
}

// ─── Runner ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let updated = 0;

async function runSuite(suiteName) {
  const fn = SUITES[suiteName];
  if (!fn) {
    console.error(`Unknown suite: ${suiteName}`);
    return;
  }

  const cases = listCases(suiteName);
  if (cases.length === 0) {
    console.warn(`  (no cases found for ${suiteName})`);
    return;
  }

  for (const c of cases) {
    const input = loadJson(c.inputPath);
    const cwd = input._cwd ? resolve(ROOT, input._cwd) : ROOT;

    let actual;
    try {
      actual = await fn(input, cwd);
    } catch (err) {
      console.error(`  ✗ ${suiteName}/${c.name}  THREW: ${err.message}`);
      failed++;
      continue;
    }

    if (UPDATE_MODE) {
      saveJson(c.snapPath, actual);
      console.log(`  ↺ ${suiteName}/${c.name}  (snapshot updated)`);
      updated++;
      continue;
    }

    if (!existsSync(c.snapPath)) {
      console.warn(`  ? ${suiteName}/${c.name}  NO SNAPSHOT — run with --update to create`);
      failed++;
      continue;
    }

    const expected = loadJson(c.snapPath);
    const diffs = structuralDiff(expected, actual);

    if (diffs.length === 0) {
      console.log(`  ✓ ${suiteName}/${c.name}`);
      passed++;
    } else {
      console.error(`  ✗ ${suiteName}/${c.name}`);
      console.error(formatDiffs(diffs));
      failed++;
    }
  }
}

async function main() {
  console.log(`\nAgentic MCP — Agent Eval${UPDATE_MODE ? " [UPDATE MODE]" : ""}\n`);

  const suitesToRun = suiteFilter
    ? [suiteFilter]
    : Object.keys(SUITES);

  for (const suite of suitesToRun) {
    console.log(`Suite: ${suite}`);
    await runSuite(suite);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed${UPDATE_MODE ? `, ${updated} updated` : ""}\n`);

  if (!UPDATE_MODE && failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Eval runner error:", err);
  process.exit(1);
});
