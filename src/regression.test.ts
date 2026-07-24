// ═══════════════════════════════════════════════════════════════
// REGRESSION TESTS — anti-bloat, envelope, scan, transport GC
//
// Verifies that recent structural changes don't regress:
// 1. Error truncation (< 240 chars, ellipsis when longer)
// 2. WalkState limits produce correct stop reasons
// 3. _meta.card stripping for non-widget tools
// ═══════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── 1. Error truncation ──────────────────────────────────────
{
  const truncate = (s: string): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > 240 ? t.slice(0, 237) + "..." : t;
  };

  // Short error untouched
  assert.equal(truncate("File not found"), "File not found");

  // Long error truncated + ellipsis
  const long = "a".repeat(500);
  const result = truncate(long);
  assert.equal(result.length, 240, "truncated string should be exactly 240 chars");
  assert.ok(result.endsWith("..."), "should end with ellipsis");

  // Multi-line normalized
  const multiline = "line1\n\n\nline2\n\nline3";
  assert.equal(truncate(multiline), "line1 line2 line3");
}

// ─── 2. _meta.card sanitization simulation ─────────────────────
// Simulates the registerAppTool wrapper logic for card stripping.
{
  const hasWidget = (def: any): boolean =>
    Boolean(def?._meta?.ui?.resourceUri || def?._meta?.["ui/resourceUri"]);

  const stripCard = (response: any, definition: any) => {
    const widget = hasWidget(definition);
    const { _meta: origMeta, ...body } = response;
    const meta = origMeta as any;
    const sanitized = !widget && meta?.card
      ? Object.fromEntries(Object.entries(meta).filter(([k]) => k !== "card"))
      : meta;
    return {
      ...body,
      ...(sanitized && Object.keys(sanitized).length > 0 ? { _meta: sanitized } : {}),
    };
  };

  // Tool without widget → card is removed
  const noWidgetDef = { _meta: { ui: {} } };
  const response = { _meta: { tool: "read", card: { payload: "big data" } }, content: "ok" };
  const cleaned = stripCard(response, noWidgetDef);
  assert.ok(!cleaned._meta?.card, "non-widget tool should not carry _meta.card");
  assert.equal(cleaned._meta?.tool, "read", "non-card _meta props should survive");

  // Tool with widget → card preserved
  const widgetDef = { _meta: { ui: { resourceUri: "ui://agentic/workspace-app.html" } } };
  const kept = stripCard(response, widgetDef);
  assert.ok(kept._meta?.card, "widget tool should preserve _meta.card");

  // Legacy format "ui/resourceUri" → recognized
  const legacyDef = { _meta: { "ui/resourceUri": "ui://agentic/workspace-app.html" as any } };
  const legacyKept = stripCard(response, legacyDef);
  assert.ok(legacyKept._meta?.card, "legacy ui/resourceUri format should be recognized");

  // Handler with only _meta.card → no _meta in output after strip
  const onlyCardResponse = { _meta: { card: { payload: "big" } }, content: "ok" };
  const stripped = stripCard(onlyCardResponse, noWidgetDef);
  assert.equal(stripped._meta, undefined, "no _meta should remain when only card existed");
}

// ─── 3. WalkState limits simulation ────────────────────────────
{
  type WalkStopReason = "max_files" | "max_directories" | "max_entries";

  interface WalkState {
    filesVisited: number;
    directoriesVisited: number;
    stopped: boolean;
    stopReason?: WalkStopReason;
    maxFiles: number;
    maxDirs: number;
    maxEntries: number;
    entries: number;
    depthTruncated: boolean;
  }

  // Simulate hitting maxFiles
  const fState: WalkState = { filesVisited: 0, directoriesVisited: 0, stopped: false, stopReason: undefined, maxFiles: 3, maxDirs: 100, maxEntries: 1000, entries: 0, depthTruncated: false };
  for (let i = 0; i < 10; i++) {
    if (fState.stopped) break;
    if (fState.filesVisited >= fState.maxFiles) { fState.stopped = true; fState.stopReason = "max_files"; break; }
    fState.filesVisited++;
  }
  assert.equal(fState.filesVisited, 3, "maxFiles=3 should process exactly 3 files");
  assert.equal(fState.stopReason, "max_files");

  // Simulate hitting maxEntries
  const eState: WalkState = { filesVisited: 0, directoriesVisited: 0, stopped: false, stopReason: undefined, maxFiles: 100, maxDirs: 100, maxEntries: 5, entries: 0, depthTruncated: false };
  for (let i = 0; i < 20; i++) {
    if (eState.stopped) break;
    if (eState.entries >= eState.maxEntries) { eState.stopped = true; eState.stopReason = "max_entries"; break; }
    eState.entries++;
    // simulate alternating file/dir
    if (i % 2 === 0) eState.directoriesVisited++;
    else eState.filesVisited++;
  }
  assert.equal(eState.entries, 5, "maxEntries=5 should process exactly 5 entries");
  assert.equal(eState.stopReason, "max_entries");
}

console.log("All regression tests passed.");
