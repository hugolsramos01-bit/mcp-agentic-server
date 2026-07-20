import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNativeDependencies } from "./native-dependency-verifier.js";

const root = await mkdtemp(join(tmpdir(), "agentic-native-verifier-"));
try {
  await writeFile(join(root, "package.json"), "{}\n");
  await mkdir(join(root, "node_modules", "working-native"), { recursive: true });
  await writeFile(join(root, "node_modules", "working-native", "package.json"), JSON.stringify({ name: "working-native", main: "index.cjs" }));
  await writeFile(join(root, "node_modules", "working-native", "index.cjs"), "module.exports = { loaded: true };\n");

  const result = verifyNativeDependencies(root, ["working-native", "missing-native"]);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.name, "missing-native");
} finally {
  await rm(root, { recursive: true, force: true });
}
