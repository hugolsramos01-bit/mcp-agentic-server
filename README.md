# Agentic MCP Server

**Turn Claude, ChatGPT, and any LLM into a safe, bloat-free Autonomous Coding Agent.**

This project is an advanced, high-performance [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server designed specifically for Agentic Coding. It gives LLMs secure access to your local repositories, but unlike naive implementations that simply dump file contents into the context window and trigger limits, this server is built with **Context Anti-Bloat**, **AST Semantic Navigation**, and **True Git Worktree Sandboxing**.

> [!WARNING]
> **Security Notice**: This tool runs on your local machine and can execute shell commands. A managed Git worktree provides an isolated Git checkout to prevent polluting your main repository, but it is **not** an operating system sandbox. It does not restrict network access or subprocesses. Always review what the LLM intends to run.

---

## 🔥 Key Innovations

### 1. Smart Context Anti-Bloat
Stop melting your LLM context windows. 
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

## 🚀 Installation & Setup

Requirements: Node `>=22.12.0 <27`

### Quick Start via NPX
The easiest way to configure and run the server is using `npx`:

```bash
npx -y mcp-agentic-server@latest doctor
npx -y mcp-agentic-server serve
```

### Manual Clone & Build
If you prefer to run from source:
```bash
git clone https://github.com/hugolsramos01-bit/mcp-agentic-server.git
cd mcp-agentic-server
npm ci
npm run build
npm run start
```

### Dependencies
- **Mandatory**: Node.js and standard OS utilities (Git).
- **Optional (`node-pty`)**: Used for interactive pseudo-terminals when running interactive shell commands. If it fails to install, the server safely falls back to standard child process execution.

---

### Setting up the Server

#### Option A: Local Clients (Claude Desktop, Cursor, Roo Code)
Configure your local MCP client configuration file:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-agentic-server@latest", "serve"],
      "env": {
        "AGENTIC_ALLOWED_ROOTS": "C:/path/to/projects"
      }
    }
  }
}
```

---

#### Option B: ChatGPT Plus — Conexão Local via Developer Mode (Custom MCP App)

O **Agentic MCP** pode ser conectado diretamente ao **ChatGPT Web** em contas **Plus** (ou Pro/Enterprise) habilitando o **Developer Mode** e expondo o servidor através de um túnel HTTPS seguro (como `ngrok` ou `Cloudflare Tunnel`).

Nesse fluxo:
- O próprio **ChatGPT Web** atua como o modelo e o orquestrador inteligente, usando a **cota normal da sua assinatura Web**.
- O **`mcp-agentic-server`** roda localmente no seu computador e fornece as ferramentas de engenharia de software (leitura/edição de arquivos, Git worktrees, AST, depuração e comandos shell).
- Não há intermediação por `chat2api`, consumo da OpenAI API Platform ou necessidade de armazenar tokens de sessão.

##### Passo a Passo de Configuração:

1. **Inicialize e inicie o servidor localmente:**
   ```bash
   npx -y mcp-agentic-server@latest init
   npx -y mcp-agentic-server@latest serve
   ```

2. **Exponha a porta local (`7676`) com um túnel HTTPS:**
   ```bash
   ngrok http 7676
   ```

3. **Habilite o Developer Mode no ChatGPT Web:**
   - Acesse [chatgpt.com](https://chatgpt.com) e vá em **Settings (Configurações) > Developer Mode (Modo Desenvolvedor)** ou seção de **Plugins / Apps**.
   - Ative o modo desenvolvedor.

4. **Conecte o App MCP Personalizado:**
   - Adicione um novo App MCP Customizado.
   - Forneça o endpoint público HTTPS gerado pelo ngrok, **obrigatoriamente terminando em `/mcp`**:
     ```text
     https://SEU-SUBDOMINIO.ngrok.app/mcp
     ```

5. **Autentique no fluxo OAuth:**
   - O ChatGPT apresentará a tela de autenticação OAuth do servidor local. Conclua a autorização no navegador.

6. **Inicie a sessão de Agentic Coding:**
   - Abra um novo chat no ChatGPT Web, garanta que o app/plugin está habilitado e solicite a abertura da workspace desejada:
     > *"Por favor, abra a workspace em `C:/caminho/para/projeto` usando a ferramenta open_workspace e faça o resumo do projeto."*

##### 📌 Observações Importantes:
* **`localhost` não funciona diretamente**: O ChatGPT Web roda na nuvem da OpenAI e exige uma URL HTTPS pública válida acessível via túnel.
* **Endpoint `/mcp` obrigatório**: A URL configurada no ChatGPT deve incluir o sufixo `/mcp`.
* **Manutenção do Túnel**: Mantenha o processo `npx mcp-agentic-server serve` e o túnel `ngrok` ativos durante toda a conversa.
* **Segurança de Acesso**: Defina a variável `AGENTIC_ALLOWED_ROOTS` em `~/.agentic/config.json` para limitar rigorosamente quais diretórios o servidor pode acessar no seu sistema.
* **Isolamento de Git Worktree**: O uso de `mode="worktree"` isola o checkout do Git para evitar corromper o ramo principal de desenvolvimento, mas **não** é uma sandbox do sistema operacional. Comandos executados afetarão o ambiente local.

---

## 🛠 Available Tools

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

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.

This project uses components heavily inspired by internal security architectures, with thanks to standard best practices in the open source community.
