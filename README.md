# Agentic MCP — Local Coding Tools for ChatGPT Developer Mode

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.hugolsramos01--bit%2Fmcp--agentic--server-blue)](https://registry.modelcontextprotocol.io/servers/io.github.hugolsramos01-bit/mcp-agentic-server)

**Connect compatible ChatGPT Web accounts to local coding tools through MCP Developer Mode.**

Agentic MCP connects ChatGPT Web Developer Mode to your local repositories through a secure Model Context Protocol (MCP) server. It supports structured file editing, shell execution, Git worktrees, semantic navigation and checkpoints.

```text
ChatGPT Web → Developer Mode → HTTPS Tunnel → Agentic MCP → Local Repository
```

> [!WARNING]
> **Security Notice**: This tool runs on your local machine and can execute shell commands. A managed Git worktree provides an isolated Git checkout to prevent polluting your main repository, but it is **not** an operating system sandbox. It does not restrict network access or subprocesses. Always review what the LLM intends to run.

> [!NOTE]
> **Disclaimer**: Agentic MCP is an independent open-source project and is not affiliated with, sponsored by, or endorsed by OpenAI. ChatGPT and OpenAI are trademarks of OpenAI. Tested by the maintainer with ChatGPT Plus using Developer Mode and an HTTPS tunnel. Availability of MCP capabilities depends on the user's ChatGPT plan, workspace configuration and current OpenAI rollout.

## 🌐 Official MCP Registry

Agentic MCP is published in the Official MCP Registry as:
`io.github.hugolsramos01-bit/mcp-agentic-server`

Install and run locally for Claude Desktop, Cursor, or other local MCP clients:
```bash
npx -y mcp-agentic-server@latest stdio
```

---

## ⚡ Quickstart: ChatGPT Plus Setup in 3 Minutes

Turn ChatGPT Web into your primary local coding agent using your existing Web plan:

1. **Initialize and start the server:**
   ```bash
   npx -y mcp-agentic-server@latest init
   npx -y mcp-agentic-server@latest serve
   ```

2. **Expose the local port (`7676`) via an HTTPS tunnel:**
   ```bash
   ngrok http 7676
   ```

3. **Enable Developer Mode in ChatGPT Web:**
   - Go to [chatgpt.com](https://chatgpt.com) > **Settings > Apps / Developer Mode** (or **Plugins / Apps**).
   - Enable **Developer Mode**.

4. **Connect the Custom MCP App:**
   - Add a new Custom MCP App.
   - Enter your public ngrok HTTPS URL ending with `/mcp`:
     ```text
     https://YOUR-SUBDOMAIN.ngrok.app/mcp
     ```

5. **Complete OAuth Authentication:**
   - Complete the local browser OAuth authorization prompt when presented.

6. **Start Coding:**
   - In a new ChatGPT Web chat, enable your custom MCP app and prompt:
     > *"Open workspace `C:/path/to/project` using open_workspace and summarize the architecture."*

---

## 🙋 Frequently Asked Questions (FAQ)

### Does this work with ChatGPT Plus?
Tested by the maintainer with ChatGPT Plus via Developer Mode and a public HTTPS tunnel (ngrok, Cloudflare Tunnel, etc.). Availability may vary by account, region, plan, and rollout.

### How does this affect my limits and billing?
When connected directly through ChatGPT Developer Mode, model usage is handled by the user's ChatGPT account rather than by an OpenAI Platform API key. Applicable limits depend on the user's plan and OpenAI policies.

### Does it require an OpenAI API key?
No OpenAI model API key is required. Authentication for the MCP server and tunnel is separate from model API billing.

### Is this an alternative to Codex or Claude Code?
Yes. It gives ChatGPT Web full local coding capabilities: file inspection, structured line-precise editing, shell execution, Git worktrees, AST navigation, and checkpoints.

---

## 🔥 Key Innovations

### 1. Smart Context Anti-Bloat
Stop melting your LLM context windows and preserve your ChatGPT Web message limits. 
* **`workspace_summary`**: Instead of a massive unified file dump, returns a compact, high-level map of the workspace (git status, package manager, key scripts, and schemas).
* **Hardened File Reads**: The `read` tool forces offset/limit paginations and strict line-range constraints. The model gets exactly what it needs, down to the line, preventing catastrophic token bloat on large files.

### 2. True Git Worktree Sandboxing
Running experimental code, tests, or destructive LLM edits in your main directory can break your Hot Module Replacement (HMR), trigger infinite loops in Next.js/Vite, or mess up your `node_modules`.
* **`open_workspace (mode="worktree")`**: Automatically spins up an isolated, detached `git worktree` *outside* your project's main directory (e.g., `~/.agentic/worktrees/`).
* The LLM can break things, install new dependencies via `worktree_install_deps` (with `allowLifecycleScripts` safely controlled), or sync uncommitted changes via `worktree_sync_changes`, all without touching your live development environment.

### 3. Semantic AST Navigation
The server parses TypeScript and JavaScript dynamically (with an in-memory LRU cache to save CPU) to provide the model with semantic maps of your architecture.
* **`next_route_map`**: Maps out Next.js App Router and Pages Router dynamically, showing roles (`api`, `page`, `layout`) and dynamic segments.
* **`payload_schema_map`**: Analyzes Payload CMS collections to return a clean map of fields, hooks, and relationships.
* **`file_dependencies`**: Maps outward (what a file imports) and inward (who imports the file) dependencies instantly.

### 4. Safe Editing & Dry-Runs
* **`edit_dry_run`**: Simulates replacements to validate exact string matching and uniqueness, returning the surrounding context of the would-be edit *without* saving to disk.
* **`changed_files_summary`**: Fast, accurate summaries of modified and newly staged files using `git status --porcelain`.

### 5. Checkpoint System
For long autonomous sessions, the agent can save point-in-time snapshots of the workspace (`checkpoint_save`), list them (`checkpoint_list`), and roll back (`checkpoint_restore`) if it goes down a bad architectural path.

---

## 💻 Local & Desktop MCP Clients (Claude Desktop, Cursor, Roo Code)

If you prefer using desktop MCP hosts, configure your client configuration file to use the `stdio` transport:

```json
{
  "mcpServers": {
    "agentic-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-agentic-server@latest", "stdio"],
      "env": {
        "AGENTIC_ALLOWED_ROOTS": "C:/path/to/projects"
      }
    }
  }
}
```

---

## 🛠 Available Tools Reference

The tool surface depends on the `AGENTIC_TOOL_MODE` setting.

| Mode | Tools included | Use case |
|------|---------------|----------|
| **`assistant`** (default) | Canonical coding workflow: workspace, context, read/search, Git, checkpoints, edit/dry-run, package scripts, worktrees, diagnostics, and semantic maps. | Full coding-agent workflow with curated model instructions. |
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
| `bash` | Fallback for shell interactions that have no typed tool; prefer `run_package_script` for package scripts and the Git tools for Git. |

### Assistant tools (mode: `assistant`)

| Tool | Description |
|------|-------------|
| `workspace_summary` | Compact architectural summary of the workspace. |
| `project_bootstrap` | Scans package managers, monorepo bounds, and base dependencies. |
| `read_many` | Read multiple files at once. |
| `tree` | Directory tree visualization. |
| `next_route_map` / `payload_schema_map` | Next.js / Payload CMS schema extraction. |
| `file_dependencies` | Inward and outward dependency map. |
| `checkpoint_*` | Save, restore, list, or delete snapshots. |
| `edit_dry_run` | Preview edits without writing. |
| `worktree_*` | Manage isolated git worktrees (create, list, sync, teardown). |
| `worktree_install_deps` | Install dependencies in a managed worktree; use `verify: true` to load native bindings. |
| `agentic_doctor` | Diagnose Node, package managers, Git and native SQLite availability. |
| `semantic_pack` | Compact goal-relevant summary with token budget. |
| `context_budget` | Estimate token count for files. |
| `expand_compressed_block` | Expand omitted blocks from read_compressed. |
| `token_audit` | Analyze token usage across files read. |
| `tournament_*` | Autonomous evaluation and judgment of changes. |
| `risk_assess_command` | Preview policy assessment before bash. |
| `changed_files_summary` | Fast Git status and diff abstraction. |

Deprecated compatibility aliases are hidden by default and never appear in the model's standard workflow. Existing clients can temporarily opt in with `AGENTIC_LEGACY_ALIASES=1`; they will be removed in the next major release. New clients must use the canonical names above: `edit_dry_run`, `next_route_map`, `payload_schema_map`, `changed_files_summary`, and `project_bootstrap`.

## 🧠 Mental Model for Agents

This server is designed to act as the "hands and eyes" of a remote AGI.
If you are building an autonomous agent or using Claude/ChatGPT for coding, instruct your agent to:
1. Always call `semantic_pack`, `project_bootstrap`, or `workspace_summary` first.
2. Use `read_compressed` for large files — expand blocks with `expand_compressed_block`.
3. Use `context_budget` to estimate token cost before reading multiple files.
4. Use `mode="worktree"` if the task involves running complex shell commands or destructive tests.
5. Use `edit_dry_run` before performing multi-line regex or exact string replacements.

## Isolation boundaries

A managed worktree is an **isolated Git checkout**, not an operating-system sandbox. It keeps experiments out of the primary checkout, but it does not restrict network access, subprocesses, credentials, CPU/memory use, or paths that are otherwise allowed to the server. Treat scripts as real local commands and use the typed Git/script tools first. Git tools only operate when the opened workspace itself is the repository root; an ancestor repository is rejected rather than exposing sibling projects.

## 📝 License & Acknowledgements

Licensed under the **MIT License**. See [LICENSE](LICENSE) for more details.


This project uses components heavily inspired by internal security architectures, with thanks to standard best practices in the open source community.

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.
