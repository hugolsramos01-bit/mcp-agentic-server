# Troubleshooting

Common setup and runtime issues and how to fix them.

## `agentic` Command Not Found

Use `npx`:

```bash
npx mcp-agentic-server init
npx mcp-agentic-server serve
```

If installed globally, make sure npm's global bin directory is on your `PATH`.

## Node Version Rejected

Agentic MCP requires Node `>=22.19.0 <27`.

```bash
node --version
```

Use a version manager (`nvm`, `fnm`, `mise`) to install Node 22 LTS.

## `better-sqlite3` Native Module Fails

This usually happens when `node_modules` were installed under a different Node
version or ABI.

```bash
npm rebuild better-sqlite3
npx mcp-agentic-server doctor
```

The production build checks native dependencies before launching.

## Tunnel URL Changed Mid-Session

Temporary tunnels (ngrok, Pinggy) rotate URLs on restart.

For a one-shot override:

```bash
AGENTIC_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx mcp-agentic-server serve
```

For a persistent URL:

```bash
npx mcp-agentic-server config set publicBaseUrl https://your-domain.example.com
```

## Getting 403 / Host Header Errors

The server derives allowed hosts from your public URL. If the tunnel URL
changes, the old host is rejected.

Run `doctor` to see what's configured:

```bash
npx mcp-agentic-server doctor
```

Only for local debugging:

```bash
AGENTIC_ALLOWED_HOSTS="*" npx mcp-agentic-server serve
```

## OAuth Redirect Rejected

The default allowlist is `chatgpt.com`, `localhost`, `127.0.0.1`. If your MCP
client redirects to a different host, extend it:

```bash
AGENTIC_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,my-client.example.com" npx mcp-agentic-server serve
```

## Owner Password Not Accepted

The password is stored in:

```text
~/.agentic/auth.json
```

Regenerate if lost:

```bash
npx mcp-agentic-server init --force
```

## Unknown `workspaceId`

Workspace IDs are session-scoped. If the server restarts, call
`open_workspace` again for that project. Sessions are persisted in SQLite
but clients should treat `open_workspace` as the entry point.

## Workspace Path Outside Allowed Roots

The folder must be inside one of the paths set during `init`. To check:

```bash
npx mcp-agentic-server config get
```

To redefine:

```bash
npx mcp-agentic-server init --force
```

## Worktree Creation Fails

Worktree mode requires:

- Git installed
- The path is inside a Git repo with at least one commit
- The requested `baseRef` resolves to a commit

For a new repo, make an initial commit first, or use checkout mode.

Uncommitted source changes are not copied into worktrees. Commit, stash, or
use checkout mode.

## Shell Commands Fail on Windows

Agentic MCP's shell tool requires Bash. Native PowerShell or `cmd.exe`
invocation is not yet supported.

Install Git for Windows (which includes Git Bash), or use WSL, MSYS2, or
Cygwin.

```bash
npx mcp-agentic-server doctor
```

Check that Bash is detected.

## Skills Not Visible

Skills are enabled by default.

```bash
AGENTIC_SKILLS=1 npx mcp-agentic-server serve
```

Agentic MCP scans:

- `~/.agents/skills`
- `.agentic/skills` inside the project
- `~/.agentic/skills`
- Bundled skills (e.g. `subagent-delegation` when `AGENTIC_SUBAGENTS=1`)
- Custom paths from `AGENTIC_SKILL_PATHS`

Agent profiles live in `~/.agentic/agents/*.md` and `.agentic/agents/*.md`.

Starter templates are under `examples/agents/` — copy them into one of the
directories above before they become active.

Legacy paths like `.pi/skills` can be added via `AGENTIC_SKILL_PATHS`.

## Widget / Review Card Missing

Per-tool widgets:

```bash
AGENTIC_WIDGETS=full
```

The aggregate `show_changes` tool is available with:

```bash
AGENTIC_WIDGETS=changes
```

Plain MCP clients that do not support ChatGPT Apps ignore widget metadata
and only display text results.


