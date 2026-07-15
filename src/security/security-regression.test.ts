import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must import from the built dist (or source if using tsx)
import { enforceSecurePath } from '../pi-tools.js';

test('Security Regression: enforceSecurePath', async (t) => {
  await t.test('Prevents cross-project escape for existing files', () => {
    // 1. Setup real directories
    const allowed = mkdtempSync(join(tmpdir(), "agentic-"));
    const appA = join(allowed, "app-a");
    const appB = join(allowed, "app-b");

    mkdirSync(appA);
    mkdirSync(appB);
    
    // Create an existing file to prevent the "file not found" early throw in resolveWorkspacePath
    const secretPath = join(appB, "secret.ts");
    writeFileSync(secretPath, "SECRET");

    // 2. Test bypass using global allowedRoots instead of workspace root
    // This demonstrates the vulnerability: using [allowed] root permits reading from app-b
    // when the current workspace is app-a.
    const bypassedPath = enforceSecurePath(
      "../app-b/secret.ts",
      appA,
      [allowed],
      false
    );
    assert.strictEqual(bypassedPath, secretPath, "Bypass succeeds if allowedRoots is global");

    // 3. Test correct behavior using strict [workspace.root] isolation
    assert.throws(() => {
      enforceSecurePath(
        "../app-b/secret.ts",
        appA,
        [appA],
        false
      );
    }, /escapes workspace root/i, "Strict workspace root isolation blocks cross-project access");
  });

  await t.test('Validates undefined requestedPath against allowedRoots', () => {
    const allowed = mkdtempSync(join(tmpdir(), "agentic-"));
    const appA = join(allowed, "app-a");
    
    // Test that cwd itself is validated
    assert.throws(() => {
      enforceSecurePath(
        undefined,
        "/outside/unauthorized/path",
        [allowed],
        false
      );
    }, /escapes workspace root/i, "Undefined requestedPath with unauthorized cwd throws");
  });
});
