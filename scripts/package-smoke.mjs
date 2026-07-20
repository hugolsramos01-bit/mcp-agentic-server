import { existsSync } from "node:fs";

const required = ["dist/cli.js", "dist/server.js", "README.md"];
const missing = required.filter((file) => !existsSync(file));
if (missing.length) throw new Error(`Package smoke check failed; missing: ${missing.join(", ")}`);
console.log("Package smoke check passed.");
