# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through Agentic MCP.

## Requirements

- Node `>=22.12.0 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local Agentic MCP server

Agentic MCP does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx mcp-agentic-server init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through Agentic MCP. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
npx mcp-agentic-server serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
AGENTIC_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx mcp-agentic-server serve
```

For a stable public URL, persist it:

```bash
npx mcp-agentic-server config set publicBaseUrl https://agentic.example.com
npx mcp-agentic-server serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, Agentic MCP shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.agentic/config.json
~/.agentic/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx mcp-agentic-server doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing Agentic MCP itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.


