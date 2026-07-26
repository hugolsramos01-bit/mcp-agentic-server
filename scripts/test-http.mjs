import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const cliPath = resolve(__dirname, "../dist/cli.js");

const port = 17676;
const ownerToken = "test-owner-token-that-is-long-enough";
const simulatedToken = "test-access-token";
const simulatedTokenHash = createHash("sha256").update(simulatedToken).digest("base64url");
const stateDir = await mkdtemp(join(tmpdir(), "agentic-http-test-"));

import { pathToFileURL } from "node:url";

// Inject token into SQLite store
const { SqliteOAuthStore } = await import(pathToFileURL(resolve(__dirname, "../dist/oauth-store.js")).href);
const store = new SqliteOAuthStore(stateDir);
store.database.sqlite.prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)").run("test", "{}", Math.floor(Date.now() / 1000));
store.saveTokenPair({
  accessToken: { clientId: "test", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: `http://127.0.0.1:${port}/mcp` },
  accessTokenHash: simulatedTokenHash,
  refreshToken: { clientId: "test", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 86400, resource: `http://127.0.0.1:${port}/mcp` },
  refreshTokenHash: "irrelevant",
});
store.close();

const serverProcess = spawn(process.execPath, [cliPath, "serve"], {
  env: {
    ...process.env,
    AGENTIC_OAUTH_OWNER_TOKEN: ownerToken,
    AGENTIC_ALLOWED_ROOTS: resolve(__dirname, ".."),
    AGENTIC_STATE_DIR: stateDir,
    AGENTIC_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PORT: port.toString(),
  },
  stdio: "pipe",
});

let serverOutput = "";
serverProcess.stdout.on("data", (data) => {
  serverOutput += data.toString();
});
serverProcess.stderr.on("data", (data) => {
  serverOutput += data.toString();
});

console.log(`Starting test MCP HTTP server on port ${port}...`);

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timeout waiting for server to start")), 5000);
  
  const check = (data) => {
    if (serverOutput.includes("agentic listening")) {
      clearTimeout(timeout);
      serverProcess.stdout.removeListener("data", check);
      serverProcess.stderr.removeListener("data", check);
      resolve();
    }
  };
  serverProcess.stdout.on("data", check);
  serverProcess.stderr.on("data", check);
  serverProcess.on("exit", (code) => reject(new Error(`Server exited with code ${code}`)));
});

try {
  // Test 1: Request without token should fail
  console.log("Test 1: Request without token");
  const noTokenRes = await fetch(`http://127.0.0.1:${port}/mcp`);
  if (noTokenRes.status !== 401 && noTokenRes.status !== 403) {
    throw new Error(`Expected 401/403 for unauthorized request, got ${noTokenRes.status}`);
  }
  console.log("  Pass");

  // Test 2: Request with valid token should succeed
  console.log("Test 2: Request with valid token");
  const validTokenRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${simulatedToken}`
    },
    body: JSON.stringify({ 
      jsonrpc: "2.0", 
      id: 2, 
      method: "initialize", 
      params: { 
        protocolVersion: "2024-11-05", 
        capabilities: {}, 
        clientInfo: { name: "test", version: "1.0.0" } 
      } 
    })
  });
  if (!validTokenRes.ok) {
    const text = await validTokenRes.text();
    throw new Error(`Expected 200 OK for authorized request, got ${validTokenRes.status}: ${text}`);
  }
  const initBody = await validTokenRes.text();
  const sessionId = validTokenRes.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("Expected mcp-session-id header in initialize response");
  }
  console.log(`  Got sessionId: ${sessionId}`);
  console.log("  Pass");

  // Test 3: Tools list
  console.log("Test 3: Tools list");
  const toolsListRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${simulatedToken}`,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/list", 
      params: {} 
    })
  });
  if (!toolsListRes.ok) {
    const text = await toolsListRes.text();
    throw new Error(`Expected 200 OK for tools/list, got ${toolsListRes.status}: ${text}`);
  }
  console.log("  Pass");

  console.log("HTTP smoke tests passed.");
} catch (err) {
  console.error("HTTP test failed:", err);
  console.error("Server Output:", serverOutput);
  process.exit(1);
} finally {
  serverProcess.kill();
  try {
    await rm(stateDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}
