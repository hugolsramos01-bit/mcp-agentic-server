# Configuration Reference

Agentic MCP can be configured through `agentic init`, persisted config files, or
environment variables.

The default files are:

```text
~/.agentic/config.json
~/.agentic/auth.json
```

Use another config directory with:

```bash
AGENTIC_CONFIG_DIR=/path/to/config npx mcp-agentic-server serve
```

## Commands

```bash
npx mcp-agentic-server init
npx mcp-agentic-server serve
npx mcp-agentic-server doctor
npx mcp-agentic-server config get
npx mcp-agentic-server config set publicBaseUrl https://agentic.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `AGENTIC_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `AGENTIC_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `AGENTIC_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `AGENTIC_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `AGENTIC_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.agentic/worktrees`. |
| `AGENTIC_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/agentic`. |
| `AGENTIC_STRICT_PVDL` | When `1`, requires `propose_plan` before `edit`/`write`. Defaults to `0`. |

## OAuth

Agentic MCP uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `AGENTIC_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `AGENTIC_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `AGENTIC_OAUTH_SCOPES` | `agentic` |
| `AGENTIC_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`AGENTIC_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `assistant` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, `bash`, and semantic tools (`coding_context`, `next_route_map`, `payload_schema_map`). |
| `minimal` | Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |

`AGENTIC_MINIMAL_TOOLS` remains a backward-compatible alias when
`AGENTIC_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.

## Widgets

`AGENTIC_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `AGENTIC_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `AGENTIC_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `AGENTIC_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `AGENTIC_SKILL_PATHS` | Optional comma-separated additional skill directories. |

Agentic MCP discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.agentic/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `AGENTIC_SUBAGENTS=1`, unless `~/.agentic/skills/subagent-delegation/SKILL.md` exists
- `AGENTIC_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `AGENTIC_SKILL_PATHS`

When Subagents are enabled, Agentic MCP discovers agent profiles
from:

- `~/.agentic/agents/*.md`
- project `.agentic/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `agentic agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `agentic agents ls`,
`agentic agents run`, and `agentic agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `AGENTIC_SKILL_PATHS` when needed.

Example:

```bash
AGENTIC_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx mcp-agentic-server serve
```

## Logging

| Variable | Default |
| --- | --- |
| `AGENTIC_LOG_LEVEL` | `info` |
| `AGENTIC_LOG_FORMAT` | `json` |
| `AGENTIC_LOG_REQUESTS` | `1` |
| `AGENTIC_LOG_ASSETS` | `0` |
| `AGENTIC_LOG_TOOL_CALLS` | `1` |
| `AGENTIC_LOG_SHELL_COMMANDS` | `0` |
| `AGENTIC_TRUST_PROXY` | `1` (enabled by default since tunnels/ngrok are the common setup) |

Set `AGENTIC_LOG_FORMAT=pretty` for local debugging.

Set `AGENTIC_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
AGENTIC_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
AGENTIC_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
AGENTIC_PUBLIC_BASE_URL="https://agentic.example.com" \
AGENTIC_WORKTREE_ROOT="$HOME/.agentic/worktrees" \
AGENTIC_TOOL_MODE="assistant" \
AGENTIC_WIDGETS="full" \
npx mcp-agentic-server serve
```

The environment assignments must be part of the same command invocation, or
exported first.


