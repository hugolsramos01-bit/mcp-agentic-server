import { spawnSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");

console.log("1. Packing tarball...");
const packRes = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack"], { cwd: rootDir, encoding: "utf-8", shell: true });
if (packRes.error || packRes.status !== 0) {
  throw new Error(`npm pack failed: ${packRes.error?.message || packRes.stderr}`);
}
const tarballName = packRes.stdout.trim().split("\n").pop().trim();
console.log(`   Packed as ${tarballName}`);

const testDir = await mkdtemp(join(tmpdir(), "agentic-smoke-"));
try {
  console.log("2. Extracting tarball via npm install...");
  const tarballPath = join(rootDir, tarballName);
  const installRes = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", tarballPath, "--prefix", testDir], { cwd: testDir, encoding: "utf-8", shell: true });
  if (installRes.error || installRes.status !== 0) throw new Error(`npm install failed: ${installRes.error?.message || installRes.stderr || installRes.stdout}`);

  const cliPath = join(testDir, "node_modules", "mcp-agentic-server", "dist", "cli.js");

  console.log("3. Testing --help...");
  const helpRes = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf-8" });
  if (!helpRes.stdout?.includes("Usage:")) {
    console.error("STDOUT:", helpRes.stdout);
    console.error("STDERR:", helpRes.stderr);
    console.error("ERROR:", helpRes.error);
    throw new Error("CLI did not output expected help text.");
  }
  console.log("   --help passed.");

  console.log("4. Testing 401 without auth (Clean Shutdown)...");
  let serverProcess;
  try {
    serverProcess = spawn(process.execPath, [cliPath, "serve"], {
      env: { ...process.env, PORT: "0", AGENTIC_PUBLIC_BASE_URL: `http://127.0.0.1:0` },
      stdio: "pipe",
    });

  let serverOutput = "";
  serverProcess.stdout.on("data", (data) => serverOutput += data.toString());
  serverProcess.stderr.on("data", (data) => serverOutput += data.toString());

    let actualPort = 0;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for server to start. Output: ${serverOutput}`)), 5000);
      const check = () => {
        const match = serverOutput.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
        if (match) {
          actualPort = parseInt(match[1]);
          clearTimeout(timeout);
          resolve();
        }
      };
      serverProcess.stdout.on("data", check);
      serverProcess.stderr.on("data", check);
    });

    console.log("SERVER OUTPUT:\n" + serverOutput);
    const noTokenRes = await fetch(`http://127.0.0.1:${actualPort}/mcp`);
  if (noTokenRes.status !== 401 && noTokenRes.status !== 403) {
    throw new Error(`Expected 401/403 for unauthorized request, got ${noTokenRes.status}`);
  }
    console.log("   401 unauthorized passed.");

    console.log("5. Testing clean shutdown...");
    serverProcess.kill("SIGINT");
    await new Promise((resolve) => {
      serverProcess.on("exit", () => resolve());
    });
    console.log("   Shutdown passed.");

    console.log("Smoke tests completed successfully!");
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
  }
} finally {
  await rm(testDir, { recursive: true, force: true });
  await rm(join(rootDir, tarballName), { force: true });
}
