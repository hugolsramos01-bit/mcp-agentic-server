import { enforceSecurePath } from './dist/pi-tools.js';
import { resolveWorkspacePath } from './dist/security/path-resolution.js';
import path from 'path';

async function runTests() {
  console.log("Running adversarial tests...");
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  function assertThrows(fn, name) {
    try {
      fn();
      console.error(`❌ FAIL: ${name} (Did not throw)`);
      failed++;
    } catch (e) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    }
  }

  const baseDir = process.cwd().replace(/\\/g, '/');
  
  // 1. Workspace /projects/a trying to access app-b/file.ts
  assertThrows(() => {
    enforceSecurePath("../../app-b/file.ts", path.join(baseDir, "src/security"), [baseDir], false);
  }, "enforceSecurePath prevents cross-project access out of cwd");

  // 5. enforceSecurePath with two allowedRoots prioritizing cwd
  try {
    const p = enforceSecurePath("./path-resolution.ts", path.join(baseDir, "src/security"), [baseDir, path.join(baseDir, "src")], false);
    assert(p.replace(/\\/g, '/').endsWith("path-resolution.ts"), "enforceSecurePath correctly resolves valid path");
  } catch(e) {
    console.error(e);
    assert(false, "enforceSecurePath threw on valid path");
  }

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);
