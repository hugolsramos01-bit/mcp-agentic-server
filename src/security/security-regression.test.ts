import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must import from the built dist (or source if using tsx)
import { enforceSecurePath } from '../pi-tools.js';
import { collectPackageScriptCommands } from './script-resolver.js';
import type { TournamentJudgeInput } from '../tournament-tools.js';

// ─── enforceSecurePath regression tests ─────────────────────────────────────
test('Security Regression: enforceSecurePath', async (t) => {
  await t.test('Prevents cross-project escape for existing files', () => {
    const allowed = mkdtempSync(join(tmpdir(), "agentic-"));
    const appA = join(allowed, "app-a");
    const appB = join(allowed, "app-b");
    mkdirSync(appA);
    mkdirSync(appB);
    const secretPath = join(appB, "secret.ts");
    writeFileSync(secretPath, "SECRET");

    const bypassedPath = enforceSecurePath("../app-b/secret.ts", appA, [allowed], false);
    assert.strictEqual(bypassedPath, secretPath, "Bypass succeeds if allowedRoots is global");

    assert.throws(() => {
      enforceSecurePath("../app-b/secret.ts", appA, [appA], false);
    }, /escapes workspace root/i, "Strict workspace root isolation blocks cross-project access");
  });

  await t.test('Validates undefined requestedPath against allowedRoots', () => {
    const allowed = mkdtempSync(join(tmpdir(), "agentic-"));
    assert.throws(() => {
      enforceSecurePath(undefined, "/outside/unauthorized/path", [allowed], false);
    }, /escapes workspace root/i, "Undefined requestedPath with unauthorized cwd throws");
  });

  // ─── Script Resolver tests ───────────────────────────────────────────────

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

    const wipeCmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "test" });
    assert.ok(wipeCmds.includes("rm -rf ./important"), "Should extract underlying rm -rf command");
    assert.ok(wipeCmds.includes("npm run wipe"), "Should include the literal script content");

    const safeCmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "safe" });
    assert.ok(safeCmds.includes("tsc"), "Should extract the nested tsc");
    assert.ok(safeCmds.includes("npm run build && rm -rf /"), "Should include the malicious outer command");

    assert.throws(() => {
      collectPackageScriptCommands({ packageJson: pkg, scriptName: "loop-a" });
    }, /Cyclic script execution detected: loop-a/i, "Should detect cyclic scripts");

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

  await t.test('Script Resolver: Canonical flag syntaxes all resolve correctly', () => {
    // All these forms should be recognised and expanded to the underlying destructive command
    const forms = [
      "npm --silent run target",    // flag before run
      "npm run --silent target",    // flag after run  (THE previously broken case)
      "npm -q run target",
      "npm run -q target",
      "npm --quiet run target",
      "npm run --quiet target",
      "npm run-script target",
      "pnpm run target",
      "yarn target",
      "yarn run target",
    ];

    for (const form of forms) {
      const pkg = {
        scripts: {
          "entry": form,
          "target": "rm -rf ./important",
        }
      };

      const cmds = collectPackageScriptCommands({ packageJson: pkg, scriptName: "entry" });
      assert.ok(
        cmds.includes("rm -rf ./important"),
        `"${form}" should resolve to the target script's content`,
      );
    }
  });

  await t.test('Script Resolver: Unsupported syntaxes fail-closed (throw)', () => {
    // These forms contain npm/yarn/pnpm invocations we cannot fully parse — must throw
    const unsupportedForms = [
      "npm --workspace foo run target",
      "npm --silent --workspace foo run target",
      "npm --prefix /foo run target",
      "npm --if-present run target",
    ];

    for (const form of unsupportedForms) {
      const pkg = {
        scripts: {
          "entry": form,
          "target": "rm -rf ./important",
        }
      };

      assert.throws(
        () => collectPackageScriptCommands({ packageJson: pkg, scriptName: "entry" }),
        /Unsupported package-manager invocation/i,
        `"${form}" must throw (unsupported syntax)`,
      );
    }
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
      'Error message should mention cycle or script not found'
    );
    activeTournaments.delete(fakeId);
  });

  await t.test('TypeScript interface has verificationScripts (plural), not verificationScript', () => {
    // Compile-time check: the type must NOT have the old singular field.
    // At runtime, verify the constructed object matches the expected shape.
    const validInput: TournamentJudgeInput = {
      tournamentId: 'x',
      verificationScripts: ['build'],
    };
    assert.ok(Array.isArray(validInput.verificationScripts), 'verificationScripts must be an array');
    // @ts-expect-error — verificationScript (singular) must not exist on TournamentJudgeInput
    const _bad: TournamentJudgeInput = { tournamentId: 'x', verificationScript: 'npm run build' };
    void _bad; // suppress unused variable lint
  });

  await t.test('Default scripts use ["typecheck","build"] - verifies actual execution path', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-defaults-')));
    // Both scripts are present so the code reaches the execFile call (node_modules also present)
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'echo built', typecheck: 'echo ok' },
    }));
    await mkdir(join(dir, 'node_modules'), { recursive: true });

    const fakeId = 'test-defaults';
    activeTournaments.set(fakeId, [{
      id: 'e3', strategy: 's3',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws3',
    }] as any);

    const result = await tournamentJudgeTool({ tournamentId: fakeId });
    const parsed = JSON.parse((result.content[0] as any).text);
    // The defaults run 'typecheck' and 'build', so there must be 2 verdicts
    assert.strictEqual(parsed.results[0].verdicts.length, 2, 'Should run exactly 2 default scripts');
    activeTournaments.delete(fakeId);
  });

  await t.test('package.json absent causes fail-closed throw', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-nopkg-')));
    // No package.json written — directory is empty
    await mkdir(join(dir, 'node_modules'), { recursive: true });

    const fakeId = 'test-no-pkg';
    activeTournaments.set(fakeId, [{
      id: 'e4', strategy: 's4',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws4',
    }] as any);

    await assert.rejects(
      () => tournamentJudgeTool({ tournamentId: fakeId, verificationScripts: ['build'] }),
      /Cannot read or parse package.json/i,
      'Missing package.json must throw (fail-closed)',
    );
    activeTournaments.delete(fakeId);
  });

  await t.test('Invalid JSON package.json causes fail-closed throw', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'tj-badjson-')));
    await writeFile(join(dir, 'package.json'), 'NOT VALID JSON {{{');
    await mkdir(join(dir, 'node_modules'), { recursive: true });

    const fakeId = 'test-bad-json';
    activeTournaments.set(fakeId, [{
      id: 'e5', strategy: 's5',
      worktree: { path: dir, sourceRoot: dir },
      workspaceId: 'ws5',
    }] as any);

    await assert.rejects(
      () => tournamentJudgeTool({ tournamentId: fakeId, verificationScripts: ['build'] }),
      /Cannot read or parse package.json/i,
      'Invalid JSON must throw (fail-closed)',
    );
    activeTournaments.delete(fakeId);
  });

});
