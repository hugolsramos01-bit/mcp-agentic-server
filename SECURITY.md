# Security and Privacy Policy

## Privacy Policy
Agentic MCP is a local server designed to act as a bridge between an MCP-compatible host (such as ChatGPT Developer Mode) and your local file system.

- **No Telemetry**: This project does not collect, store, or transmit any telemetry, usage metrics, analytics, or tracking data to any third party.
- **Local Processing**: Prompts and tool arguments sent by the LLM client arrive directly at your local machine.
- **Data Flow**: The only data that leaves your machine is the direct response to the tool calls (e.g., file contents, search results, or command outputs) returned back to your connected LLM client.

## Security Policy
## Supported Versions

Only the latest major version is actively supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability within Agentic MCP Server, please send an e-mail to the maintainers or report it via GitHub Security Advisories. 

We consider the following to be vulnerabilities:
- Bypasses of the `AGENTIC_ALLOWED_ROOTS` restrictions.
- Remote Code Execution (RCE) on the host machine without explicit OAuth approval from the user.
- Secrets leakage from the host environment to the LLM when specifically blacklisted.

We do **not** consider the following to be vulnerabilities:
- The fact that the LLM can read and write files within the allowed workspace roots.
- The fact that the LLM can execute arbitrary bash commands (this is an intended feature; the user must review and approve them).

### Important Boundaries
- **Not an OS Sandbox**: Managed Git worktrees provide an isolated checkout for code experiments, but they are **not** an operating system sandbox. Worktrees do not restrict network access, subprocesses, credentials, or CPU/memory limits.
- **Destructive Actions**: While the server requires explicit confirmation for commands, the LLM has access to your local machine as the user running the server. Always review actions carefully.

For more details on the threat model, please refer to [docs/security.md](docs/security.md).
