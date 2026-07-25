// ═══════════════════════════════════════════════════════════════
// REGRESSION TESTS — anti-bloat, envelope, scan, transport GC
//
// Tests REAL exported functions, not simulations:
// 1. toolErrorPreview — error truncation
// 2. truncateOutput — central inline output size guard
// 3. formatAgentsPath — path formatting
// 4. WorkspaceRegistry.openWorkspace — scan diagnostics
// 5. toolWidgetDescriptorMeta — widget UI gate logic
// 6. ensureCheckoutWorkspaceRoot — directory creation
// ═══════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolErrorPreview, toolWidgetDescriptorMeta, truncateOutput } from "./server/tool-utils.js";
import { formatAgentsPath, ensureCheckoutWorkspaceRoot, WorkspaceRegistry } from "./workspaces.js";
import { loadConfig } from "./config.js";

const testDir = await mkdtemp(join(tmpdir(), "agentic-regression-"));

try {
  // ─── 1. toolErrorPreview — real exported truncation function ──
  {
    type TC = { type: "text"; text: string };

    // Short error untouched
    assert.equal(toolErrorPreview([{ type: "text", text: "File not found" } as TC]), "File not found");

    // Long error truncated with ellipsis
    const longText = "a".repeat(500);
    const result = toolErrorPreview([{ type: "text", text: longText } as TC]);
    assert.equal(result?.length, 240, "toolErrorPreview should return exactly 240 chars for 500-char input");
    assert.ok(result?.endsWith("..."), "truncated error should end with ellipsis");

    // Multi-line normalized to single line
    assert.equal(
      toolErrorPreview([{ type: "text", text: "line1\n\n\nline2\n\nline3" } as TC]),
      "line1 line2 line3",
    );

    // Whitespace normalization
    assert.equal(
      toolErrorPreview([{ type: "text", text: "  too    many   spaces  " } as TC]),
      "too many spaces",
    );

    // Empty/undefined returns undefined
    assert.equal(toolErrorPreview([{ type: "text", text: "" } as TC]), undefined);
    assert.equal(toolErrorPreview([{ type: "text", text: "   " } as TC]), undefined);
  }

  // ─── 2. truncateOutput — central inline output size guard ──
  {
    // Short text: no truncation
    const short = truncateOutput("Hello world", 12000);
    assert.equal(short.truncated, false);
    assert.equal(short.preview, "Hello world");
    assert.equal(short.characters, 11);
    assert.equal(short.omittedCharacters, 0);

    // Long text: head + tail with marker
    const long = "a".repeat(500);
    const capped = truncateOutput(long, 100);
    assert.equal(capped.truncated, true);
    assert.ok(capped.preview.startsWith("aaa"), "should start with head");
    assert.ok(capped.preview.endsWith("aaa"), "should end with tail");
    assert.ok(capped.preview.includes("characters omitted"), "should include omission marker");
    assert.equal(capped.characters, 500);
    assert.equal(capped.omittedCharacters, 500 - 100);
    assert.ok(capped.returnedCharacters < 500, "returned should be less than original");

    // Exactly at limit: no truncation
    const exact = "x".repeat(12000);
    const exactCapped = truncateOutput(exact, 12000);
    assert.equal(exactCapped.truncated, false);
    assert.equal(exactCapped.characters, 12000);

    // Unicode (multi-byte characters) — counted correctly
    const emoji = "🔥".repeat(100); // 100 emoji * 2 JS chars = 200
    const emojiCapped = truncateOutput(emoji, 50);
    assert.equal(emojiCapped.truncated, true);
    assert.ok(emojiCapped.preview.includes("🔥"), "should preserve emoji");
    assert.equal(emojiCapped.characters, 200);

    // Empty string
    const empty = truncateOutput("", 100);
    assert.equal(empty.truncated, false);
    assert.equal(empty.preview, "");
  }

  // ─── 3. formatAgentsPath — real exported function ─────────────
  {
    // Absolute path outside workspace → returns as-is (normalized)
    const result = formatAgentsPath("/outside/file.md", "/workspace");
    assert.equal(result, "/outside/file.md");

    // Path inside workspace → returns relative
    assert.equal(
      formatAgentsPath("/workspace/src/nested/AGENTS.md", "/workspace"),
      "src/nested/AGENTS.md",
    );

    // Path equal to workspace root → returns the root path (by design)
    assert.equal(
      formatAgentsPath("/workspace", "/workspace"),
      "/workspace",
    );

    // No workspace root → returns path as-is with forward slashes
    assert.equal(
      formatAgentsPath(join("users", "test", "file.md"), undefined),
      "users/test/file.md",
    );
  }

  // ─── 4. Real scan diagnostics via WorkspaceRegistry ──────────
  {
    const baseDir = join(testDir, "scan-test");

    // Create a directory with moderate depth + some AGENTS.md files
    await mkdir(join(baseDir, "src", "components"), { recursive: true });
    await mkdir(join(baseDir, "src", "lib"), { recursive: true });
    await mkdir(join(baseDir, "docs"), { recursive: true });
    await mkdir(join(baseDir, "generated"), { recursive: true });
    await writeFile(join(baseDir, "AGENTS.md"), "root\n");
    await writeFile(join(baseDir, "src", "AGENTS.md"), "src\n");
    await writeFile(join(baseDir, "docs", "AGENTS.md"), "docs\n");
    // Create a deep path to test depth limits
    let deep = join(baseDir, "deep");
    for (let i = 0; i < 15; i++) {
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, "AGENTS.md"), `depth ${i}\n`);
      deep = join(deep, `sub${i}`);
    }

    const scanConfig = loadConfig({
      AGENTIC_CONFIG_DIR: join(testDir, "scan-config"),
      AGENTIC_ALLOWED_ROOTS: baseDir,
      AGENTIC_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "2",
    });
    const ctx = await new WorkspaceRegistry(scanConfig).openWorkspace(baseDir);

    // Should find AGENTS.md files
    assert.ok(ctx.availableAgentsFiles.length > 0, "should find some AGENTS.md");

    // Deep tree should trigger depth truncation — unconditional assertions
    assert.ok(ctx.agentsFileScan !== undefined, "deep tree should produce scan diagnostics");
    assert.ok(ctx.agentsFileScan!.maxDepthReached !== undefined,
      `maxDepthReached should be defined (got ${ctx.agentsFileScan!.maxDepthReached})`);
    assert.ok(
      ["max_files", "max_directories", "max_entries"].includes(ctx.agentsFileScan!.stopReason ?? "") ||
      ctx.agentsFileScan!.maxDepthReached,
      `valid reason: ${ctx.agentsFileScan!.stopReason}, maxDepthReached=${ctx.agentsFileScan!.maxDepthReached}`,
    );
    assert.ok(ctx.agentsFileScan!.filesVisited >= 0, "filesVisited should be >= 0");
    assert.ok(ctx.agentsFileScan!.directoriesVisited >= 0, "directoriesVisited should be >= 0");
    assert.ok(ctx.agentsFileScan!.entriesVisited >= 0, "entriesVisited should be >= 0");
  }

  // ─── 5. toolWidgetDescriptorMeta — widget gate logic ─────────
  {
    const makeConfig = (widgets: string) => loadConfig({
      AGENTIC_CONFIG_DIR: join(testDir, "widget-config"),
      AGENTIC_ALLOWED_ROOTS: testDir,
      AGENTIC_WIDGETS: widgets,
      AGENTIC_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "3",
    });

    // 'off' mode: no widget descriptor even for workspace
    const offMeta = toolWidgetDescriptorMeta(makeConfig("off"), "workspace");
    assert.deepEqual(offMeta, { _meta: {} }, "off mode should return empty _meta");

    // 'changes' mode: workspace tools get widget, read tools don't
    const changesWorkspace = toolWidgetDescriptorMeta(makeConfig("changes"), "workspace");
    assert.ok(changesWorkspace._meta?.ui, "changes mode should attach widget for workspace");

    const changesRead = toolWidgetDescriptorMeta(makeConfig("changes"), "read");
    assert.deepEqual(changesRead, { _meta: {} }, "changes mode should NOT attach widget for read");

    // 'full' mode: all tool kinds get widget
    const fullWs = toolWidgetDescriptorMeta(makeConfig("full"), "workspace");
    assert.ok(fullWs._meta?.ui, "full mode should attach widget for workspace");

    const fullRead = toolWidgetDescriptorMeta(makeConfig("full"), "read");
    assert.ok(fullRead._meta?.ui, "full mode should attach widget for read");
  }

  // ─── 6. ensureCheckoutWorkspaceRoot — real directory creation ──
  {
    const newDir = join(testDir, "ensure-root-test", "a", "b", "c");
    const stats = await ensureCheckoutWorkspaceRoot(newDir);
    assert.ok(stats.isDirectory(), "ensureCheckoutWorkspaceRoot should create directory");
    assert.equal(existsSync(newDir), true, "directory should exist on disk");

    // Second call should not throw
    const stats2 = await ensureCheckoutWorkspaceRoot(newDir);
    assert.equal(stats2.isDirectory(), true, "second call should succeed");
  }

  console.log("All regression tests passed (using real exports).");

} finally {
  // Cleanup
  await import("node:fs/promises").then(fs => fs.rm(testDir, { recursive: true, force: true }));
}
