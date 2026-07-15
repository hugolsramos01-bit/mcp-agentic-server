import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureAgenticDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "agentic-empty-config-test-"));
const baseEnv = {
  AGENTIC_CONFIG_DIR: emptyConfigDir,
  AGENTIC_ALLOWED_ROOTS: process.cwd(),
  AGENTIC_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "assistant");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).agenticSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).agenticAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, AGENTIC_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { AGENTIC_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { AGENTIC_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "agentic-seeded-skills-test-"));
const seededSkillPaths = ensureAgenticDefaultSkills({ AGENTIC_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureAgenticDefaultSkills({ AGENTIC_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "invalid" }),
  /Invalid AGENTIC_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "minimal" }),
  /Invalid AGENTIC_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_WIDGETS: "write-only" }),
  /Invalid AGENTIC_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_TOOL_MODE: "invalid" }),
  /Invalid AGENTIC_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: true,
});

assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, AGENTIC_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_LOG_LEVEL: "trace" }),
  /Invalid AGENTIC_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_LOG_FORMAT: "color" }),
  /Invalid AGENTIC_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["agentic"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, AGENTIC_OAUTH_SCOPES: "agentic,admin" }).oauth.scopes,
  ["agentic", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, AGENTIC_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, AGENTIC_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ AGENTIC_CONFIG_DIR: emptyConfigDir, AGENTIC_ALLOWED_ROOTS: process.cwd() }),
  /AGENTIC_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_OAUTH_OWNER_TOKEN: "too-short" }),
  /AGENTIC_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, AGENTIC_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, AGENTIC_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, AGENTIC_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "agentic-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://agentic.example.com",
    subagents: true,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ AGENTIC_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://agentic.example.com");
assert.equal(fileConfig.subagents, true);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "agentic.example.com",
]);





