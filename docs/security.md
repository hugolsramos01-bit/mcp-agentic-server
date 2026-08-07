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

### Preferred shell usage

In the default `safe` mode, the server instructs the model to **not** create or modify project files through the shell; use `edit`/`write` instead. In every mode, typed tools remain preferred for code search, file reads, and Git inspection because they are narrower and easier to audit.

`trusted` intentionally permits shell-based file writes and inline scripting. `full` removes command-policy restrictions altogether, so these become workflow preferences rather than enforced command-policy boundaries.

### Command security modes

`AGENTIC_SECURITY_MODE` selects how the built-in command policy is applied. It is independent from `AGENTIC_TOOL_MODE`, which only controls which MCP tools are exposed.

| Mode | Behavior |
|------|----------|
| **`safe`** (default) | Preserves the strict policy. Inline `python -c` / `node -e`, redirects, heredocs, `tee`, in-place shell editors, and similar shell file-writing forms are blocked. Destructive commands remain blocked or dangerous. |
| **`trusted`** | Allows inline scripting and shell file-writing forms, and routine package installs no longer warn. Destructive commands such as recursive force delete, force push, hard reset, destructive SQL, filesystem/device operations, and broad Windows deletes remain protected. |
| **`full`** | Bypasses command-policy regex rules entirely, including destructive-command rules. Use only when you intentionally grant the connected MCP client unrestricted shell-command authority. |

Persist a mode with:

```bash
agentic config set securityMode trusted
# or
agentic config set securityMode full
```

Restart the server after changing the persisted mode. `AGENTIC_SECURITY_MODE` can also be set per process.

The policy assessment itself still reports four verdicts in `safe`/`trusted`:

| Verdict | Behavior |
|---------|----------|
| **`allow`** | Command passes policy checks. |
| **`warn`** | Command is allowed but carries a policy warning, such as `git push` or `sudo`. |
| **`dangerous`** | The current executor denies the command in `safe`/`trusted`; `risk_assess_command` marks that stronger authorization would be required. |
| **`block`** | Command is denied in the active mode. `full` bypasses command-policy verdicts. |

Use `risk_assess_command` to preview a command under the server's active mode without executing it.

OAuth remains required in every mode, and workspace/file MCP tools continue to enforce `AGENTIC_ALLOWED_ROOTS`. **The shell itself is not confined by that allowlist.** A shell command can access files, credentials, network resources, and system paths available to the local user account. `trusted` and `full` therefore increase real machine-level risk, not just project-level risk.

### Recommendation for production use

- Use a dedicated, non-admin system user for the Agentic MCP process
- Set `AGENTIC_ALLOWED_ROOTS` to the narrowest set of directories needed
- Review shell logs if `AGENTIC_LOG_SHELL_COMMANDS=1` is enabled
- Consider running Agentic MCP inside a container or VM for additional isolation

## Production Dependency Integrity

Release builds fail when the production dependency tree contains a `high` or
`critical` npm advisory. The gate audits both forms of the software:

- the repository after `npm ci`
- the generated `.tgz` after installation in an empty consumer directory

The second audit is required because published dependencies may include their own
`npm-shrinkwrap.json`, which can override a consumer project's root lockfile.

Version 1.5.0 temporarily pins the coding primitives to
`@hugolsramos01-bit/pi-coding-agent@0.80.7-agentic.1`. This controlled fork is
based on upstream `0.80.7` and changes only package identity, security pins,
lock-generation tooling, generated lock artifacts and internal package
references needed by the fork. It contains no runtime behavior refactor and
remains exact-pinned until upstream Pi publishes an equivalently audited tree.

Moderate advisories are reviewed and tracked, but the release gate currently
blocks on `high` and `critical` findings.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, Agentic MCP logs requests and tool calls. Shell command previews are
disabled unless `AGENTIC_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.


