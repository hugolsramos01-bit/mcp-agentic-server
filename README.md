# Agentic MCP Server

**Turn Claude, ChatGPT, and any LLM into a safe, bloat-free Autonomous Coding Agent.**

This project is an advanced, high-performance [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server designed specifically for Agentic Coding. It gives LLMs secure access to your local repositories, but unlike naive implementations that simply dump file contents into the context window and trigger limits, this server is built with **Context Anti-Bloat**, **AST Semantic Navigation**, and **True Git Worktree Sandboxing**.

---

## 🔥 Key Innovations

### 1. Smart Context Anti-Bloat
Stop melting your LLM context windows. 
* **`coding_context`**: Instead of a massive unified file dump, returns a compact, high-level map of the workspace (git status, package manager, key scripts, and schemas).
* **Hardened File Reads**: The `read` tool forces offset/limit paginations and strict line-range constraints. The model gets exactly what it needs, down to the line, preventing catastrophic token bloat on large files.

### 2. True Git Worktree Sandboxing
Running experimental code, tests, or destructive LLM edits in your main directory can break your Hot Module Replacement (HMR), trigger infinite loops in Next.js/Vite, or mess up your `node_modules`.
* **`open_workspace (mode="worktree")`**: Automatically spins up an isolated, detached `git worktree` *outside* your project's main directory (e.g., `~/.agentic/worktrees/`).
* The LLM can break things, install new dependencies via `worktree_install_deps`, or sync uncommitted changes via `worktree_sync_changes`, all without touching your live development environment.

### 3. Semantic AST Navigation
The server parses TypeScript and JavaScript dynamically (with an in-memory LRU cache to save CPU) to provide the model with semantic maps of your architecture.
* **`next_route_map`**: Maps out Next.js App Router and Pages Router dynamically, showing roles (`api`, `page`, `layout`) and dynamic segments.
* **`payload_schema_map`**: Analyzes Payload CMS collections to return a clean map of fields, hooks, and relationships.
* **`file_dependencies`**: Maps outward (what a file imports) and inward (who imports the file) dependencies instantly.

### 4. Safe Editing & Dry-Runs
* **`preview_edit`**: A dry-run tool that simulates replacements to validate exact string matching and uniqueness, returning the surrounding context of the would-be edit *without* saving to disk.
* **`changed_files_summary`**: Fast, accurate summaries of modified and newly staged files using `git status --porcelain`.

### 5. Checkpoint System
For long autonomous sessions, the agent can save point-in-time snapshots of the workspace (`checkpoint_save`), list them (`checkpoint_list`), and roll back (`checkpoint_restore`) if it goes down a bad architectural path.

---

## 🚀 Installation & Setup

Requirements: Node `>=22.12.0 <27`

```bash
npm install
npm run build
npm run start
```

### Setting up the Server

**For Local Clients (Claude Desktop, Cursor, Roo Code):**
Configure your MCP client to start the server. Add the following to your MCP config:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-agentic-server", "serve"],
      "env": {
        "AGENTIC_ALLOWED_ROOTS": "C:/path/to/projects"
      }
    }
  }
}
```

**For Cloud-hosted Clients (ChatGPT Web, Claude Web):**
To connect cloud-hosted agents to your local machine, use a secure tunnel (e.g., Cloudflare Tunnel, ngrok, Pinggy).
1. Start your tunnel (e.g., pointing to port 7676).
2. Start the MCP server: `npm run start`
3. Connect your MCP client to the public `/mcp` URL.

---

## 🛠 Available Tools

The tool surface depends on the `AGENTIC_TOOL_MODE` setting.

| Mode | Tools included | Use case |
|------|---------------|----------|
| **`assistant`** (default) | `open_workspace`, `read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`, `tree`, `coding_context`, `read_many`, `safe_file_preview`, `git_status/diff/log`, `run_package_script`, `next_route_map`, `payload_schema_map`, `file_dependencies`, `checkpoint_*`, `edit_dry_run`, `show_changes`, `worktree_*`, `suggest_checks`, `risk_assess_command`, `propose_plan` | Full coding-agent workflow |
| **`full`** | Base tools + `grep`, `glob`, `ls` | Manual inspection via shell |
| **`minimal`** | `open_workspace`, `read`, `write`, `edit`, `bash` | Restricted surface |


> **Note:** The `assistant` mode is recommended for the full agentic coding experience. Set `AGENTIC_TOOL_MODE=assistant` in your `.env` or environment.

### Core tools (always available)

| Tool | Description |
|------|-------------|
| `open_workspace` | Opens a project. Supports `mode="checkout"` or `mode="worktree"`. |
| `read` | Hardened file reader with `startLine`, `endLine`, `offset`, `limit`. |
| `write` | Create or overwrite files. |
| `edit` | Targeted string replacements. |
| `bash` | Shell commands for tests, builds, git. |

### Assistant tools (mode: `assistant`)

| Tool | Description |
|------|-------------|
| `coding_context` | Compact architectural summary of the workspace. |
| `read_many` | Read multiple files at once. |
| `tree` | Directory tree visualization. |
| `next_route_map` / `payload_schema_map` | Next.js / Payload CMS schema extraction. |
| `file_dependencies` | Inward and outward dependency map. |
| `checkpoint_*` | Save, restore, list snapshots. |
| `edit_dry_run` | Preview edits without writing. |
| `worktree_*` | Manage isolated git worktrees. |
| `semantic_pack` | Compact goal-relevant summary with token budget. |
| `context_budget` | Estimate token count for files. |
| `expand_compressed_block` | Expand omitted blocks from read_compressed. |
| `token_audit` | Analyze token usage across files read. |
| `risk_assess_command` | Preview policy assessment before bash. |

Deprecated compatibility aliases are hidden by default. Existing clients can temporarily opt in with `AGENTIC_LEGACY_ALIASES=1`; they will be removed in the next major release. New clients must use the canonical tool names shown above.

## 🧠 Mental Model for Agents

This server is designed to act as the "hands and eyes" of a remote AGI.
If you are building an autonomous agent or using Claude/ChatGPT for coding, instruct your agent to:
1. Always call `semantic_pack` or `coding_context` first.
2. Use `read_compressed` for large files — expand blocks with `expand_compressed_block`.
3. Use `context_budget` to estimate token cost before reading multiple files.
4. Use `mode="worktree"` if the task involves running complex shell commands or destructive tests.
5. Use `edit_dry_run` before performing multi-line regex or exact string replacements.

## 📝 License & Acknowledgements

Licensed under the **MIT License**. See [LICENSE](LICENSE) for more details.

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.

This project uses components heavily inspired by internal security architectures, with thanks to standard best practices in the open source community.
