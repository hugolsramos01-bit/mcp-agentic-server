# Security Policy

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

For more details on the threat model, please refer to [docs/security.md](docs/security.md).
