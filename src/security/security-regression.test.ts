import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must import from the built dist (or source if using tsx)
import { enforceSecurePath } from '../pi-tools.js';
import { collectPackageScriptCommands } from './script-resolver.js';

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

  await t.test('Script Resolver: Recursively extracts scripts and detects cycles', () => {
    const pkg = {
      scripts: {
        "test": "npm run wipe",
        "wipe": "rm -rf ./important",
        "safe": "npm run build && rm -rf /",
        "build": "tsc",
        "loop-a": "npm run loop-b",
        "loop-b": "npm run loop-a",
        "deep": "npm run d1",
        "d1": "npm run d2", "d2": "npm run d3", "d3": "npm run d4", "d4": "npm run d5",
        "d5": "npm run d6", "d6": "npm run d7", "d7": "npm run d8", "d8": "npm run d9",
        "d9": "npm run d10", "d10": "npm run d11", "d11": "echo deep"
      }
    };

    // 1. Basic sub-script
    const wipeCmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "test" });
    assert.ok(wipeCmds.includes("rm -rf ./important"), "Should extract underlying rm -rf command");
    assert.ok(wipeCmds.includes("npm run wipe"), "Should include the literal script content");

    // 2. Bypass via && mixed script
    const safeCmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "safe" });
    assert.ok(safeCmds.includes("tsc"), "Should extract the nested tsc");
    assert.ok(safeCmds.includes("npm run build && rm -rf /"), "Should include the malicious outer command");

    // 3. Cycle detection
    assert.throws(() => {
      collectPackageScriptCommands({ packageJson: pkg, scriptName: "loop-a" });
    }, /Cyclic script execution detected: loop-a/i, "Should detect cyclic scripts");

    // 4. Depth limit
    assert.throws(() => {
      collectPackageScriptCommands({ packageJson: pkg, scriptName: "deep" });
    }, /Max script depth exceeded/i, "Should prevent deep recursion");
  });

  await t.test('Script Resolver: Pre and Post Hooks', () => {
    const pkg = {
      scripts: {
        "pretest": "echo pre",
        "test": "npm run main",
        "main": "echo main",
        "posttest": "echo post"
      }
    };

    const cmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "test" });
    assert.ok(cmds.includes("echo pre"));
    assert.ok(cmds.includes("echo main"));
    assert.ok(cmds.includes("echo post"));
  });


  await t.test('Script Resolver: Alternative Syntaxes (run-script, --silent)', () => {
    const pkg = {
      scripts: {
        "test": "npm --silent run safe",
        "safe": "npm run-script safe2",
        "safe2": "npm -q run safe3",
        "safe3": "npm --quiet run-script destructive",
        "destructive": "rm -rf /"
      }
    };

    const cmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "test" });
    assert.ok(cmds.includes("rm -rf /"), "Should extract destructive command despite npm flags/run-script syntax");
  });

});
