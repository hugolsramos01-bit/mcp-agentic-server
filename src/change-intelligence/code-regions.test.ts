import { test } from "node:test";
import * as assert from "node:assert";
import { extractCodeRegions } from "./code-regions.js";

test("extractCodeRegions", async (t) => {
  await t.test("função top-level", () => {
    const code = `
function helloWorld() {
  console.log("hello");
}
    `.trim();
    const regions = extractCodeRegions("test.ts", code);
    assert.strictEqual(regions.length, 1);
    assert.deepStrictEqual(regions[0], {
      name: "helloWorld",
      qualifiedName: undefined,
      kind: "function",
      startLine: 1,
      endLine: 3,
      matchedKeywords: undefined
    });
  });

  await t.test("classe, método, getter, setter, constructor", () => {
    const code = `
export class MyClass {
  constructor() {
    this.value = 1;
  }
  get value() { return this._val; }
  set value(v) { this._val = v; }
  myMethod() {
    return this.value;
  }
}
    `.trim();
    const regions = extractCodeRegions("test.ts", code);
    // MyClass (1-10), constructor (2-4), value (getter, 5-5), value (setter, 6-6), myMethod (7-9)
    assert.strictEqual(regions.length, 5);
    const classRegion = regions.find(r => r.name === "MyClass");
    assert.ok(classRegion);
    assert.strictEqual(classRegion.kind, "class");
    
    const constructorRegion = regions.find(r => r.name === "constructor");
    assert.ok(constructorRegion);
    assert.strictEqual(constructorRegion.qualifiedName, "MyClass.constructor");
    assert.strictEqual(constructorRegion.startLine, 2);
    assert.strictEqual(constructorRegion.endLine, 4);

    const getterRegion = regions.find(r => r.name === "value" && r.startLine === 5);
    assert.ok(getterRegion);
    assert.strictEqual(getterRegion.qualifiedName, "MyClass.value");

    const setterRegion = regions.find(r => r.name === "value" && r.startLine === 6);
    assert.ok(setterRegion);
    assert.strictEqual(setterRegion.qualifiedName, "MyClass.value");

    const methodRegion = regions.find(r => r.name === "myMethod");
    assert.ok(methodRegion);
    assert.strictEqual(methodRegion.qualifiedName, "MyClass.myMethod");
  });

  await t.test("interface e type alias e enum", () => {
    const code = `
interface User {
  name: string;
}
type UserId = number;
enum Status {
  Active,
  Inactive
}
    `.trim();
    const regions = extractCodeRegions("test.ts", code);
    assert.strictEqual(regions.length, 3);
    assert.strictEqual(regions.find(r => r.name === "User")?.kind, "interface");
    assert.strictEqual(regions.find(r => r.name === "UserId")?.kind, "type");
    assert.strictEqual(regions.find(r => r.name === "Status")?.kind, "enum");
  });

  await t.test("exported const arrow function e múltiplas variáveis no mesmo statement", () => {
    const code = `
export const a = () => {}, b = 2, c = function() { return 3; };
const d = () => {};
    `.trim();
    // 'a' is exported arrow function -> variable
    // 'b' is exported variable -> variable
    // 'c' is exported function expression -> variable
    // 'd' is NOT exported, but is initialized with arrow function -> variable
    const regions = extractCodeRegions("test.ts", code);
    assert.strictEqual(regions.length, 4);
    assert.ok(regions.find(r => r.name === "a"));
    assert.ok(regions.find(r => r.name === "b"));
    assert.ok(regions.find(r => r.name === "c"));
    assert.ok(regions.find(r => r.name === "d"));
  });

  await t.test("React component TSX e default export", () => {
    const code = `
export default function App() {
  return <div>Hello</div>;
}
    `.trim();
    const regions = extractCodeRegions("test.tsx", code);
    assert.strictEqual(regions.length, 1);
    assert.strictEqual(regions[0].name, "App");
    assert.strictEqual(regions[0].kind, "function");
  });

  await t.test("default export expression", () => {
    const code = `
export default class {
  method() {}
}
    `.trim();
    const regions = extractCodeRegions("test.ts", code);
    // 1 default class, 1 method inside
    assert.strictEqual(regions.length, 2);
    assert.strictEqual(regions.find(r => r.name === "default")?.kind, "class");
  });

  await t.test("CRLF handling", () => {
    const code = "function test() {\r\n  return 1;\r\n}";
    const regions = extractCodeRegions("test.ts", code);
    assert.strictEqual(regions.length, 1);
    assert.strictEqual(regions[0].startLine, 1);
    assert.strictEqual(regions[0].endLine, 3);
  });

  await t.test("arquivo sintaticamente incompleto", () => {
    const code = `
export class Incomplete {
  method() {
    if (true) {
  }
}
    `.trim();
    const regions = extractCodeRegions("test.ts", code);
    // AST tries its best
    assert.strictEqual(regions.length, 2); // Incomplete, method
  });

  await t.test("scoring e ranking (anchor keywords)", () => {
    const code = `
export class SqliteWorkspaceStore {
  updateStatus() {}
  touchSession() {}
  #flushTouches() {}
}
export function getWorkspace() {}
    `.trim();
    const regions = extractCodeRegions("test.ts", code, {
      anchorKeywords: ["touch", "session", "workspace", "store"]
    });
    
    // Exact qualified names:
    // SqliteWorkspaceStore
    // SqliteWorkspaceStore.updateStatus
    // SqliteWorkspaceStore.touchSession
    // SqliteWorkspaceStore.#flushTouches
    // getWorkspace

    assert.ok(regions.length >= 5);
    // Highest should be SqliteWorkspaceStore.touchSession because "touch" and "session" match in name, "workspace" "store" match in qualified name.
    const top = regions[0];
    assert.strictEqual(top.qualifiedName, "SqliteWorkspaceStore.touchSession");
  });
});
