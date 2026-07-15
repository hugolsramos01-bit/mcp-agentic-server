# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `agentic` Command Not Found

Use `npx`:

```bash
npx mcp-agentic-server init
npx mcp-agentic-server serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

Agentic MCP requires Node `>=22.12.0 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx mcp-agentic-server doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx mcp-agentic-server config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
AGENTIC_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx mcp-agentic-server serve
```

For a stable URL:

```bash
npx mcp-agentic-server config set publicBaseUrl https://agentic.example.com
```

## Host Header Or 403 Problems

Agentic MCP derives allowed hosts from the configured public URL.

Run:

```bash
npx mcp-agentic-server doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
AGENTIC_ALLOWED_HOSTS="*" npx mcp-agentic-server serve
```

## OAuth Redirect Host Rejected

By default, Agentic MCP allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
AGENTIC_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" npx mcp-agentic-server serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.agentic/auth.json
```

To regenerate setup:

```bash
npx mcp-agentic-server init --force
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted, but clients should still treat
`open_workspace` as the way to begin a fresh working session.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
npx mcp-agentic-server config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx mcp-agentic-server init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

Agentic MCP shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx mcp-agentic-server doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
AGENTIC_SKILLS=1 npx mcp-agentic-server serve
```

Agentic MCP looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.agentic/skills`

It also checks compatibility and custom paths:

- the bundled `subagent-delegation` skill when `AGENTIC_SUBAGENTS=1`, unless `~/.agentic/skills/subagent-delegation/SKILL.md` exists
- `AGENTIC_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `AGENTIC_SKILL_PATHS`

When `AGENTIC_SUBAGENTS=1`, Agentic MCP loads agent profiles from
`~/.agentic/agents/*.md` and project `.agentic/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. The bundled
`subagent-delegation` skill keeps the model-facing workflow to
`agentic agents ls`, `agentic agents run`, and `agentic agents show`.
`agentic agents ls` lists existing subagent sessions, not profile
definitions.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `AGENTIC_SKILL_PATHS` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Per-tool widget cards are enabled by default with:

```bash
AGENTIC_WIDGETS=full
```

The aggregate `show_changes` tool is only exposed with
`AGENTIC_WIDGETS=changes`. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results.


