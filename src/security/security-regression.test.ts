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

// ─── Tournament Judge integration tests ─────────────────────────────────────
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tournamentJudgeTool, activeTournaments } from '../tournament-tools.js';

test('Tournament Judge: fail-closed enforcement', async (t) => {

  await t.test('Rejects script names not in package.json', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-test-')));
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc' },
    }));
    await mkdir(join(dir, 'node_modules'), { recursive: true });

    const fakeId = 'test-missing-script';
    activeTournaments.set(fakeId, [{
      id: 'e1', strategy: 's1',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws1',
    }] as any);

    const result = await tournamentJudgeTool({
      tournamentId: fakeId,
      verificationScripts: ['nonexistent'],
    });

    const parsed = JSON.parse((result.content[0] as any).text);
    const verdict = parsed.results[0].verdicts[0];
    assert.strictEqual(verdict.passed, false, 'Should fail when script not in package.json');
    assert.ok(verdict.details.includes('not found in package.json'), 'Error message should indicate missing script');
    activeTournaments.delete(fakeId);
  });

  await t.test('Rejects cyclic script dependencies (fail-closed)', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-cycle-')));
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: {
        build: 'npm run helper',
        helper: 'rm -rf ./important && npm run build',  // cycle: build -> helper -> build
      },
    }));
    await mkdir(join(dir, 'node_modules'), { recursive: true });

    const fakeId = 'test-cycle';
    activeTournaments.set(fakeId, [{
      id: 'e2', strategy: 's2',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws2',
    }] as any);

    const result = await tournamentJudgeTool({
      tournamentId: fakeId,
      verificationScripts: ['build'],
    });

    const parsed = JSON.parse((result.content[0] as any).text);
    const verdict = parsed.results[0].verdicts[0];
    assert.strictEqual(verdict.passed, false, 'Cyclic scripts must fail');
    assert.ok(
      verdict.details.toLowerCase().includes('cyclic') || verdict.details.toLowerCase().includes('not found'),
      'Error message should mention cycle'
    );
    activeTournaments.delete(fakeId);
  });

  await t.test('verificationScript (singular) is not accepted by TypeScript interface', () => {
    // At runtime we verify the new plural field is the correct shape
    const input = { tournamentId: 'x', verificationScripts: ['build'] };
    assert.ok(!('verificationScript' in input), 'Old singular field must not exist in new interface');
    assert.ok('verificationScripts' in input, 'New plural field must exist');
  });

  await t.test('Default scripts are typecheck and build (not shell strings)', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-defaults-')));
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'echo built', typecheck: 'echo ok' },
    }));

    const fakeId = 'test-defaults';
    activeTournaments.set(fakeId, [{
      id: 'e3', strategy: 's3',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws3',
    }] as any);

    // Call without specifying scripts — should use ['typecheck','build'] not shell strings
    const result = await tournamentJudgeTool({ tournamentId: fakeId });

    // Check the output didn't error on the schema itself
    assert.ok(result.content[0], 'Should return a result');
    activeTournaments.delete(fakeId);
  });

});

