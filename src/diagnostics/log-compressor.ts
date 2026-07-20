export interface DiagnosticSummary {
  status: "success" | "failed";
  command: string;
  summary: {
    errors: number;
    warnings: number;
    primaryError?: {
      file?: string;
      line?: number;
      code?: string;
      message: string;
    }
  };
  suggestedReads: { path: string; startLine?: number; endLine?: number }[];
  nextActions?: { tool: string; arguments: any; reason: string; priority: number }[];
  rawOutputId?: string;
  filteredLog: string;
}

/**
 * Very simple regex-based log compressor for TS/Vite/Next errors.
 */
export function compressLog(command: string, rawLog: string, exitCode: number, outputId?: string, cwd?: string): DiagnosticSummary {
  const lines = rawLog.split('\n');
  const filteredLines: string[] = [];
  
  let errors = 0;
  let warnings = 0;
  let primaryError: DiagnosticSummary['summary']['primaryError'] = undefined;
  const suggestedReads: DiagnosticSummary['suggestedReads'] = [];

  // Ordered from specific to generic — reduces false positives from
  // lines like "build succeeded with 0 errors" matching the generic fallback.
  const errorPatterns = [
    /error TS\d{4}/i,                        // TypeScript: error TS2345
    /\d+:\d+\s+error\s+\S/,                 // ESLint: 10:3  error  no-unused-vars
    /^\s*×\s/,                              // Next.js: × Error: ...
    /\[vite\]\s+error/i,                    // Vite: [vite] error
    /SyntaxError:|ReferenceError:|TypeError:/, // JS runtime errors
    /error\b(?!s\s+found|\s+free|\s+corrected|\s+0\s)/i, // generic "error" but NOT "0 errors", "error free", etc.
  ];
  const warningPatterns = [
    /warning TS\d{4}/i,
    /\d+:\d+\s+warning\s+\S/,
    /\[vite\]\s+warn/i,
    /warn\b(?!ing: 0|\s+free)/i,
  ];

  function isError(line: string): boolean {
    return errorPatterns.some(p => p.test(line));
  }
  function isWarning(line: string): boolean {
    return !isError(line) && warningPatterns.some(p => p.test(line));
  }

  // Strip ANSI escape codes before any line processing.
  // Test runners (Jest, Vitest) and pnpm output color codes that corrupt file paths
  // in suggestedReads when the model tries to open them.
  // eslint-disable-next-line no-control-regex
  const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
  function stripAnsi(s: string): string { return s.replace(ANSI_REGEX, ""); }

  // match file paths like src/foo.ts:12:34 or /absolute/path/file.js(12,34)
  const fileRegex = /([a-zA-Z0-9_/\-.\\]+\.(ts|tsx|js|jsx))[:(]([0-9]+)/;
  // match TS error codes in message
  const tsCodeRegex = /(TS[0-9]{4}):\s*(.*)/;

  // Vitest/Jest-specific patterns: detect test failures to prioritize correct files
  // Capture groups: [1]=path, [2]=extension, [3]=test name (after `>`)
  const vitestFailMatch = /[❯×]\s+((?:tests?\/)?[a-zA-Z0-9_/\-.\\]+\.(?:spec|test)\.(ts|tsx|js|jsx))(?:\s*>\s*(.*))?/;
  const jestFailMatch = /FAIL\s+([a-zA-Z0-9_/\-.\\]+\.(ts|tsx|js|jsx))/;
  const vitestSummaryMatch = /Tests?\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/;
  // Extract assertion details: "expected X to deeply equal Y" or "expected X to equal Y"
  const vitestAssertMatch = /expected\s+(.+?)\s+to\s+(?:deeply\s+)?(equal|contain|match|be|have)(?:\s+(.+))?$/;
  // Extract line from stack: "at ... (file.test.ts:42:15)"
  const vitestStackLineMatch = /\(([a-zA-Z0-9_/\-.\\]+\.(?:spec|test)\.(ts|tsx|js|jsx)):(\d+):(\d+)\)/;
  const failedTestFiles: { path: string; reason?: string }[] = [];
  let vitestTotalFailed = 0;
  let vitestTotalPassed = 0;
  // Track unique failing test files so we don't overcount vitest per-assertion lines
  const uniqueFailFiles = new Set<string>();

  /**
   * Resolve a test file path relative to cwd when the raw path doesn't exist
   * as-is (common in monorepos where vitest runs from apps/ subdirectory).
   * Resolution is also done at the call site (assistant-tools.ts) for all
   * suggestedReads paths.
   */
  function resolveVitestPath(cwd: string | undefined, rawPath: string): string {
    return rawPath; // placeholder — actual resolution happens in assistant-tools.ts
  }

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine); // clean line for matching/extraction
    let keep = false;

    // Vitest/Jest failed test file detection (highest priority)
    const vf = line.match(vitestFailMatch);
    if (vf) {
      const testFile = vf[1];
      const testName = vf[3]; // vf[2] is the file extension (ts/tsx), vf[3] is the test name
      
      // Resolve path relative to cwd if available — vitest in monorepos emits
      // paths relative to the app directory (e.g. tests/smoke/file.test.ts)
      // but read tool expects paths relative to workspace root.
      const resolvedTestFile = resolveVitestPath(cwd, testFile);
      
      if (!failedTestFiles.some(f => f.path === resolvedTestFile)) {
        failedTestFiles.push({ path: resolvedTestFile, reason: testName ? `failing test: "${testName}"` : "failing test" });
      }
      if (!primaryError && testName) {
        primaryError = { file: resolvedTestFile, message: `Test failure: ${testName}` };
      } else if (!primaryError) {
        primaryError = { file: resolvedTestFile, message: "Test failure" };
      }
      // Count 1 per unique test file, not per assertion line
      keep = true;
    }

    const jf = line.match(jestFailMatch);
    if (jf) {
      if (!failedTestFiles.some(f => f.path === jf[1])) {
        failedTestFiles.push({ path: jf[1], reason: "Jest test suite failed" });
      }
    }

    const vs = line.match(vitestSummaryMatch);
    if (vs) {
      vitestTotalFailed = parseInt(vs[1]);
      vitestTotalPassed = parseInt(vs[2]);
      keep = true;
    }

    // Extract assertion details from vitest output:
    // "expected 'alpha' to deeply equal 'beta'" → better primaryError.message
    const va = line.match(vitestAssertMatch);
    if (va) {
      const expected = va[1].trim();
      const op = va[2];
      const received = (va[3] || "").trim();
      keep = true;
      if (primaryError) {
        // Enhance existing primaryError with assertion detail
        if (!primaryError.message.includes("expected")) {
          primaryError.message = `${primaryError.message} — expected ${expected} to ${op} ${received}`;
        }
      } else {
        primaryError = { message: `Assertion failed: expected ${expected} to ${op} ${received}` };
      }
      // Try to extract line number from a nearby stack frame
      for (let li = lines.indexOf(rawLine) + 1; li < Math.min(lines.length, lines.indexOf(rawLine) + 15); li++) {
        const sl = stripAnsi(lines[li]);
        const sm = sl.match(vitestStackLineMatch);
        if (sm && sm[2]) {
          if (!primaryError?.file) {
            primaryError = { ...(primaryError || { message: "" }), file: sm[1], line: parseInt(sm[2]) };
          }
          keep = true;
          break;
        }
      }
    }

    if (isError(line)) {
      errors++;
      keep = true;
    } else if (isWarning(line)) {
      warnings++;
      keep = true;
    }

    const fileMatch = line.match(fileRegex);
    if (fileMatch) {
      keep = true;
      const file = fileMatch[1];
      const lineNum = parseInt(fileMatch[3], 10);
      
      // Prevent duplicates
      if (!suggestedReads.some(s => s.path === file && s.startLine === lineNum)) {
        suggestedReads.push({
           path: file,
           startLine: Math.max(1, lineNum - 10),
           endLine: lineNum + 10
        });
      }

      if (!primaryError) {
        primaryError = { file, line: lineNum, message: line.trim() };
      }
    }

    const tsMatch = line.match(tsCodeRegex);
    if (tsMatch) {
      keep = true;
      if (primaryError) {
        primaryError.code = tsMatch[1];
        if (!primaryError.message) primaryError.message = tsMatch[2];
      } else {
        primaryError = { code: tsMatch[1], message: tsMatch[2] };
      }
    }

    // Keep short indented lines — likely stack trace context or code snippets
    if (line.startsWith(' ') && line.length < 100) {
      keep = true;
    }

    if (keep) {
      filteredLines.push(line);
    }
  }

  // Fallback if no primary error found but exit code != 0
  if (exitCode !== 0 && !primaryError && lines.length > 0) {
    primaryError = { message: filteredLines[0] || lines[lines.length - 1] };
  }

  // If Vitest detected test failures, prioritize those files over generic file matches
  // and inject a summary line at the top
  if (failedTestFiles.length > 0 && vitestTotalFailed > 0) {
    // Override error count with actual vitest summary numbers
    errors = vitestTotalFailed;
    
    // Replace suggestedReads with only the actually failing test files
    // (remove build tool internals and non-test files)
    suggestedReads.length = 0;
    for (const ft of failedTestFiles) {
      suggestedReads.push({ path: ft.path, startLine: 1, endLine: 50 });
    }
    // If primaryError points to a non-test file (e.g. hook file, build tool), 
    // replace it with the first actual test failure
    if (primaryError && !primaryError.file?.includes(".test.") && !primaryError.file?.includes(".spec.")) {
      primaryError = { file: failedTestFiles[0].path, message: `Test failure: ${vitestTotalFailed} tests failed` };
    }
    // Prepend test failure summary
    const failureSummary = `Tests: ${vitestTotalFailed} failed, ${vitestTotalPassed} passed.\nFailing files: ${failedTestFiles.map(f => f.path).join(", ")}`;
    filteredLines.unshift(failureSummary);
  }

  // A successful process is authoritative. Test runners often send expected
  // exceptions, TAP diagnostics, or deprecation text to stderr; presenting
  // those as errors after exit code 0 sends agents on a false investigation.
  if (exitCode === 0) {
    errors = 0;
    primaryError = undefined;
    suggestedReads.length = 0;
  }

  return {
    status: exitCode === 0 ? "success" : "failed",
    command,
    summary: {
      errors: Math.max(errors, exitCode !== 0 ? 1 : 0),
      warnings,
      primaryError
    },
    suggestedReads: suggestedReads.slice(0, 5), // Keep top 5 max
    rawOutputId: outputId,
    filteredLog: filteredLines.slice(0, 50).join('\n') + (filteredLines.length > 50 ? '\n... [truncated]' : '')
  };
}
