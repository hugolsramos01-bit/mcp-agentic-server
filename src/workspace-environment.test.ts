import test from "node:test";
import assert from "node:assert/strict";
import { workspaceProcessEnvironment } from "./workspace-environment.js";

test("workspace env strips Agentic control-plane values and consumed legacy bindings", () => {
  const env = workspaceProcessEnvironment({
    baseEnv: {
      PATH: "C:\\tools",
      PROJECT_TOKEN: "keep-me",
      HOST: "127.0.0.1",
      PORT: "7676",
      AGENTIC_OAUTH_OWNER_TOKEN: "owner-secret",
      AGENTIC_ALLOWED_ROOTS: "C:\\projects",
      AGENTIC_PUBLIC_BASE_URL: "https://agentic.example",
      AGENTIC_CONFIG_DIR: "C:\\agentic-config",
      AGENTIC_SECURITY_MODE: "trusted",
    },
    serverHost: "127.0.0.1",
    serverPort: 7676,
    workspaceId: "ws_test",
    workspaceRoot: "C:\\projects\\app",
  });

  assert.equal(env.PATH, "C:\\tools");
  assert.equal(env.PROJECT_TOKEN, "keep-me");
  assert.equal(env.HOST, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.AGENTIC_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(env.AGENTIC_ALLOWED_ROOTS, undefined);
  assert.equal(env.AGENTIC_PUBLIC_BASE_URL, undefined);
  assert.equal(env.AGENTIC_CONFIG_DIR, undefined);
  assert.equal(env.AGENTIC_SECURITY_MODE, undefined);
  assert.equal(env.AGENTIC_WORKSPACE_ID, "ws_test");
  assert.equal(env.AGENTIC_WORKSPACE_ROOT, "C:\\projects\\app");
});

test("namespaced server bindings preserve generic project HOST and PORT", () => {
  const env = workspaceProcessEnvironment({
    baseEnv: {
      AGENTIC_HOST: "127.0.0.1",
      AGENTIC_PORT: "7676",
      HOST: "project.internal",
      PORT: "3000",
      PROJECT_FLAG: "1",
    },
    serverHost: "127.0.0.1",
    serverPort: 7676,
  });

  assert.equal(env.HOST, "project.internal");
  assert.equal(env.PORT, "3000");
  assert.equal(env.PROJECT_FLAG, "1");
  assert.equal(env.AGENTIC_HOST, undefined);
  assert.equal(env.AGENTIC_PORT, undefined);
});

test("workspace overrides are applied after filtering", () => {
  const env = workspaceProcessEnvironment({
    baseEnv: {
      PORT: "7676",
      AGENTIC_OAUTH_OWNER_TOKEN: "owner-secret",
      NO_COLOR: "0",
    },
    serverPort: 7676,
    overrides: {
      NO_COLOR: "1",
      CUSTOM_WORKSPACE_ENV: "yes",
    },
  });

  assert.equal(env.PORT, undefined);
  assert.equal(env.AGENTIC_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.CUSTOM_WORKSPACE_ENV, "yes");
});
