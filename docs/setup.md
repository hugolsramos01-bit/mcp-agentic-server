# Setup Guide

This guide walks through getting Agentic MCP running so ChatGPT or another
MCP host can work with your local projects.

## What You Need

- **Node** `>=22.19.0 <27`
- **npm** or **pnpm**
- **Git**
- **Bash** (Git Bash or WSL on Windows)
- **A public HTTPS URL** that tunnels to your local machine

Agentic MCP does not provide a tunnel. You bring your own — Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or a reverse proxy all work.

## Install

```bash
npx mcp-agentic-server init
```

This walks you through:

1. **Allowed roots** — which folders the MCP host can access. Keep this tight.
   ```text
   /home/user/projects
   C:\Users\alice\work
   ```
2. **Local port** — defaults to `7676`.
3. **Public URL** — the tunnel origin (without `/mcp`).

All config lands in:

```text
~/.agentic/config.json
~/.agentic/auth.json
```

## Start the Server

```bash
npx mcp-agentic-server serve
```

If your tunnel URL changes mid-session, override it without rewriting config:

```bash
AGENTIC_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx mcp-agentic-server serve
```

## Connect Your Client

Point your MCP client to:

```text
https://your-tunnel.example.com/mcp
```

When the client connects, open the approval URL in a browser and enter the
Owner password shown during `init`.

## Verify

```bash
npx mcp-agentic-server doctor
```

This prints the active config, platform info, available tools, and SQLite status.

## Local Development

```bash
git clone <repo>
cd mcp-agentic-server
npm install --include=dev
npm run dev
```


