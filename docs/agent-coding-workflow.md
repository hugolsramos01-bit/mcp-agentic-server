# Agentic Coding Workflow

Agentic MCP brings an advanced autonomous coding-agent loop to any MCP host (Claude Desktop, Cursor, Roo Code, ChatGPT, etc):
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

The MCP Client should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode
- the user explicitly asks to reopen

## Checkout Mode

Checkout mode is the default. Agentic MCP opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants the agent to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.agentic/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
Agentic MCP reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, Agentic MCP loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Discovery Discipline

Use the narrowest evidence path that can safely complete the request:

- if the target file is already known, inspect that file directly and narrowly
- if a symbol is known but its location is not, search for that symbol and read only the relevant match
- use goal-directed repository discovery only when the implementation files are genuinely unknown
- use broad architectural context only when cross-domain structure is actually required

**Stop discovery once there is enough evidence to make the requested scoped change safely.** Do not inspect backend code, tests, schemas, adjacent modules, or historical knowledge merely because they might be related. Expand scope only when a concrete dependency, contract, failing check, or the user's request requires it.

If reasoning is interrupted before any workspace mutation, continue from the evidence already gathered. A checkpoint should be restored only to undo an applied workspace change, not merely because reasoning was interrupted or the approach changed.

Fast context is intentionally bounded for model latency. Multi-file reads default to roughly 12k tokens unless a caller explicitly requests more. Fast task discovery carries an 8k read budget in its next step and caps oversized code regions to focused 160-line windows around goal anchors instead of recommending an entire giant component or function. Historical `.agentic/knowledge` entries are knowledge, not executable instruction files.

## Skills

Skills are enabled by default for coding-agent workflows.

Agentic MCP discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.agentic/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `AGENTIC_SUBAGENTS=1`, unless `~/.agentic/skills/subagent-delegation/SKILL.md` exists
- `AGENTIC_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `AGENTIC_SKILL_PATHS`

When Subagents are enabled, Agentic MCP discovers agent profiles
from `~/.agentic/agents/*.md` and project `.agentic/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `AGENTIC_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. Agentic MCP only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `AGENTIC_SKILLS=0` to hide skills from workspace output. Set
`AGENTIC_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`agentic agents ls`, `agentic agents run`, and `agentic agents show`
workflow. The catalog comes from `open_workspace`; `agentic agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

Agentic MCP exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

By default, Agentic MCP also runs in `AGENTIC_TOOL_MODE=assistant`, exposing semantic tools (`workspace_summary`) and the `bash` tool. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection instead of dedicated tools.

Use `AGENTIC_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`AGENTIC_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

## Proportional Change Workflow

When `AGENTIC_STRICT_PVDL` is disabled, Agentic MCP uses proportional workflow guidance instead of requiring the full PVDL sequence for every edit:

- **QUICK** — localized, low-risk, obvious changes such as labels, CSS, small JSX/conditions, comments, and tiny config adjustments. Inspect only what is necessary, edit/write directly, and if verification is useful run only the cheapest relevant targeted check. Do not run a full build or broad suite merely because code changed. `propose_plan`, `edit_dry_run`, `checkpoint_save`, and `suggest_checks` are not default steps.
- **STANDARD** — multi-file or behavioral changes with moderate blast radius. Plan when sequencing or uncertainty warrants it, dry-run ambiguous/large replacements, checkpoint when rollback would be useful, and use `suggest_checks` when verification is not obvious. Verify cheap-first: static analysis and nearby tests before broader suites. Build when imports/shared types, compiler/bundler configuration, dependency metadata, release scope, or fan-out make artifact validation meaningful.
- **CRITICAL** — authentication, permissions/RLS, database migrations or destructive data work, security policy, CI/release, dependency/supply-chain, and other high-impact changes. Use the full PVDL workflow and strong verification, including build/integration/e2e where relevant.

Escalate to a higher level when discovery reveals more risk. Do not add governance tool calls solely because a file is being edited.

`AGENTIC_STRICT_PVDL=1` always overrides this proportional guidance, including in turbo mode. In strict mode, `propose_plan` is required before `edit`/`write`; the server enforces that requirement.

## Show Changes

By default, `AGENTIC_WIDGETS=full`.

In that mode, Agentic MCP attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `AGENTIC_WIDGETS=off` to disable widget UI, or `AGENTIC_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, models should call it exactly once after the
final file modification in any turn that changes files. The tool only requires
the `workspaceId`; Agentic MCP automatically compares against the last shown
checkpoint and advances that checkpoint after rendering the aggregate diff.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.


