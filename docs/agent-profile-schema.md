# Subagent Profile Format

Profile files are Markdown with YAML frontmatter. They define reusable roles
("reviewer", "explorer", "implementer") that the supervising model can delegate
work to. Agentic MCP handles provider invocation — the profile only describes
what the agent should do.

Profile files are discovered from:

- `~/.agentic/agents/*.md`
- `.agentic/agents/*.md`

The files under `examples/agents/` are starter templates — copy them into one
of the directories above to activate.

## Minimum Viable Profile

```yaml
---
schema: agentic-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter Reference

### `schema`

Optional identifier. Currently only `agentic-agent/v1`.

### `name`

The short name used by `agentic agents run <name> "<prompt>"`. Lowercase
kebab-case. If omitted, the filename (without `.md`) is used.

### `description`

Required. A one-liner shown in `open_workspace` so the orchestrating model
can pick the right profile.

### `provider`

Required. One of:

| Provider   | Integration   |
|------------|--------------|
| `codex`    | Codex SDK    |
| `claude`   | Claude Code   |
| `opencode` | OpenCode SDK  |
| `pi`       | Pi RPC mode   |
| `cursor`   | ACP           |
| `copilot`  | ACP           |

Unknown providers are rejected at load time.

### `model`

Optional. A provider-specific model name or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `thinking`

Optional. Provider-specific reasoning effort. Values are passed through
verbatim — no translation happens between harnesses.

```yaml
thinking: low
thinking: high
```

Mapped per provider:

- **claude**: SDK effort level with adaptive thinking
- **codex**: SDK model reasoning effort
- **pi**: `--thinking` flag
- **opencode**: model variant
- **cursor/copilot**: ACP thought-level config (when supported)

### `disabled`

```yaml
disabled: true
```

Profiles marked as disabled are not exposed in `open_workspace`.

## Markdown Body

The body is the system prompt prepended when the profile is launched. It stays
out of the orchestrating model's context until the profile is activated.

Recommended body content:

- When this profile is appropriate.
- Whether the worker may modify files or should remain read-only.
- Expected output format.
- Review or testing criteria.

## Model-Facing Workflow

The subagent-delegation skill exposes exactly three commands:

```bash
agentic agents ls                   # list active sessions
agentic agents run <name> "<prompt>" # launch a profile
agentic agents show <id>            # inspect a session
```

`open_workspace` returns compact metadata (name, description, provider) for
available profiles. The full profile body is not included until the profile
is launched.

### `agentic agents ls`

Lists active subagent sessions for the current workspace — not profile
definitions.

## What Is Not Supported

- Custom CLI-based agents outside the provider list above.
- Parsing worker output to infer diffs, changed files, or test results.
- Exposing raw provider transcripts by default.
- Teaching the orchestrating model provider-specific CLIs.
- First-class MCP subagent tools (future).


