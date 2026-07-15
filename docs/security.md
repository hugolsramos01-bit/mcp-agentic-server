# Security Model

Agentic MCP exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

Agentic MCP only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`agentic init` generates an Owner password and stores it in:

```text
~/.agentic/auth.json
```

When an MCP client connects, Agentic MCP shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
AGENTIC_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

Agentic MCP needs `AGENTIC_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `AGENTIC_PUBLIC_BASE_URL`.

By default, Agentic MCP derives allowed Host headers from the local host and public
URL. Use `AGENTIC_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

Agentic MCP does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. Agentic MCP OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool (`bash`) is powerful by design. It runs commands using your
local user account. **Agentic MCP is NOT a full security sandbox.**

### What the shell can do

- Run any command your user account can run
- Access any file on your system (not just allowed roots)
- Read environment variables, network resources, and mounted volumes
- Execute scripts, compilers, package managers, and system tools

### What the shell should NOT be used for

The server instructs the model to **not** use the shell for:
- Creating or modifying project files (use `edit`/`write` instead)
- Searching code or reading files (use `read`/`grep`/`glob` instead)
- Git status inspection (use `git_status`/`git_diff`/`git_log` instead)

### Security policy — risk levels

Agentic MCP includes a built-in security policy that classifies shell commands
into four risk levels:

| Level | Behavior | Examples |
|-------|----------|----------|
| **`allow`** | Runs without restriction | `ls`, `cat`, `node --version` |
| **`warn`** | Runs, but the model notifies you about the risk first | `git push`, `npm install`, shell redirects, `sudo` |
| **`dangerous`** | Blocked — model must ask you for explicit confirmation | `git push --force`, `DROP TABLE`, `DELETE FROM` |
| **`block`** | Always blocked, cannot be overridden | `rm -rf`, `mkfs`, `chmod 777`, `dd if=/dev/zero` |

The policy can be inspected and customized at runtime via:
- `risk_assess_command` — preview the assessment without running
- `set_policy` — replace rules with custom patterns
- `reset_policy` — restore defaults

### Recommendation for production use

- Use a dedicated, non-admin system user for the Agentic MCP process
- Set `AGENTIC_ALLOWED_ROOTS` to the narrowest set of directories needed
- Review shell logs if `AGENTIC_LOG_SHELL_COMMANDS=1` is enabled
- Consider running Agentic MCP inside a container or VM for additional isolation

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, Agentic MCP logs requests and tool calls. Shell command previews are
disabled unless `AGENTIC_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.


