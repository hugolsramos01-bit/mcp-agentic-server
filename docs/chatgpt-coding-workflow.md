# ChatGPT Coding Workflow

Agentic MCP brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

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

Use this when the user wants ChatGPT to work in the current checkout.

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

By default, Agentic MCP also runs in `AGENTIC_TOOL_MODE=assistant`, exposing semantic tools (`coding_context`) and the `bash` tool. Use `bash` with command-line tools
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


