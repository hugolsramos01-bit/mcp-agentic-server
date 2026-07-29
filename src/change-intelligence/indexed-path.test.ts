import test from "node:test";
import assert from "node:assert";
import { createIndexedPath } from "./indexed-path.js";

test("createIndexedPath extracts correct segments", () => {
  const file1 = createIndexedPath("src/components/Button.tsx");
  assert.strictEqual(file1.path, "src/components/Button.tsx");
  assert.strictEqual(file1.base, "Button.tsx");
  assert.strictEqual(file1.dir, "src/components");
  assert.strictEqual(file1.nameOnly, "button");

  const file2 = createIndexedPath("package.json");
  assert.strictEqual(file2.base, "package.json");
  assert.strictEqual(file2.dir, ".");
  assert.strictEqual(file2.nameOnly, "package");
  
  const file3 = createIndexedPath(".env");
  assert.strictEqual(file3.base, ".env");
  assert.strictEqual(file3.dir, ".");
  assert.strictEqual(file3.nameOnly, "");
});

test("classifies only actual declaration files as configuration", () => {
  assert.strictEqual(
    createIndexedPath("src/valid.ts").kind,
    "source",
  );

  assert.strictEqual(
    createIndexedPath("src/types.d.ts").kind,
    "configuration",
  );

  assert.strictEqual(
    createIndexedPath("src/generated.d.ts").kind,
    "configuration",
  );
});
