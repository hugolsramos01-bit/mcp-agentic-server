import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileDependenciesTool } from "./ast-tools.js";

const execFileAsync = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), "agentic-file-dependencies-"));

try {
  await mkdir(join(workspace, "apps", "web", "lib"), { recursive: true });
  await mkdir(join(workspace, "apps", "web", "app"), { recursive: true });
  await mkdir(join(workspace, "apps", "web", "tests"), { recursive: true });
  await writeFile(join(workspace, "apps", "web", "tsconfig.json"), JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
  }));
  await writeFile(join(workspace, "apps", "web", "lib", "public-site.ts"), "export const publicSite = true;\n");
  await writeFile(join(workspace, "apps", "web", "app", "route.ts"), "import { publicSite } from '@/lib/public-site';\nvoid publicSite;\n");
  await writeFile(join(workspace, "apps", "web", "tests", "public-site.test.ts"), "import { publicSite } from '../lib/public-site';\nvoid publicSite;\n");
  await git(workspace, ["init"]);
  await git(workspace, ["add", "."]);

  const result = await fileDependenciesTool(workspace, "apps/web/lib/public-site.ts");
  const payload = JSON.parse((result.content[0] as { text: string }).text) as { inward_dependencies: string[] };
  assert.deepEqual(payload.inward_dependencies.sort(), [
    "apps/web/app/route.ts",
    "apps/web/tests/public-site.test.ts",
  ]);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

import { payloadSchemaMapTool } from "./ast-tools.js";

try {
  const payloadResult = await payloadSchemaMapTool(join(process.cwd(), "test", "fixtures", "payload-nested"));
  const payloadData = JSON.parse((payloadResult.content[0] as { text: string }).text) as { collections: any[] };
  
  const products = payloadData.collections.find((c: any) => c.slug === "products");
  assert.ok(products, "Products collection should be found");
  
  // Enforce no duplicated root fields. The 'Products' fixture has top-level:
  // title (text), details (group), variants (array), content (blocks), tabs (tabs)
  // None of their children (sku, weight, color, stock, body, image, metaTitle, etc) should be at root.
  const rootFieldNames = products.fieldsTree.map((f: any) => f.name).sort();
  assert.deepEqual(rootFieldNames, ["content", "details", "tabs", "title", "variants"]);
} catch (err) {
  console.error("Payload test failed:", err);
  process.exitCode = 1;
}
