import test from 'node:test';
import assert from 'node:assert';
import { runProcess } from './run-process.js';
import * as os from 'node:os';

test('Process Runner', async (t) => {
  await t.test('Executes a simple command successfully', async () => {
    const result = await runProcess("node", ["-e", "console.log('hello world')"], { cwd: process.cwd() });
    
    assert.strictEqual(result.status, "success");
    if (result.status === "success") {
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes("hello world"));
    }
  });

  await t.test('Handles non-zero exit codes', async () => {
    const result = await runProcess("node", ["-e", "process.exit(1)"], { cwd: process.cwd() });
    
    assert.strictEqual(result.status, "command_failed");
    if (result.status === "command_failed") {
      assert.strictEqual(result.exitCode, 1);
    }
  });

  await t.test('Handles ENOENT (executable not found) as infrastructure_error', async () => {
    const result = await runProcess("does-not-exist-executable", [], { cwd: process.cwd() });
    
    assert.strictEqual(result.status, "infrastructure_error");
    if (result.status === "infrastructure_error") {
      assert.strictEqual(result.code, "ENOENT");
    }
  });

  await t.test('Handles timeouts', async () => {
    // node -e "setTimeout(() => console.log('done'), 5000)"
    const result = await runProcess("node", ["-e", "setTimeout(() => console.log('done'), 5000)"], { cwd: process.cwd(), timeoutMs: 100 });
    
    assert.strictEqual(result.status, "timeout");
  });

  await t.test('Resolves Windows .cmd extensions for package managers', async () => {
    // We can only truly test this if npm exists in the environment
    const result = await runProcess("npm", ["--version"], { cwd: process.cwd() });
    
    // Regardless of platform, it shouldn't fail with ENOENT if npm is installed.
    // If it's Windows, the resolver should have appended .cmd so spawn() succeeds.
    assert.ok(result.status === "success" || result.status === "command_failed", `Expected success or command_failed but got ${JSON.stringify(result)}`);
    
    if (os.platform() === 'win32') {
      assert.ok(result.executable.endsWith('.cmd'));
    } else {
      assert.strictEqual(result.executable, 'npm');
    }
  });
});
