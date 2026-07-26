# Agent Eval Baseline

Deterministic evaluation harness for Agentic MCP tool behavior.

## Purpose

Capture the **structured output** of each tool against fixed inputs
before behavioral changes. Any subsequent branch that alters a tool
must demonstrate that all previously passing cases still pass, and
must add new cases that cover the changed behavior.

## Structure

```
eval/
  README.md                  ← this file
  run.mjs                    ← runner: executes all cases, compares to snapshots
  cases/
    suggest_checks/
      agentic-self.input.json     ← input fixture
      agentic-self.snap.json      ← expected structured output snapshot
    read/
      ...
    read_many/
      ...
    grep/
      ...
    semantic_pack/
      ...
  snapshots/                 ← auto-generated; committed alongside cases
  lib/
    diff.mjs                 ← structured diff helper
    assert.mjs               ← typed assertion helpers
```

## Running

```bash
# Record fresh snapshots (first run or after intentional change)
node eval/run.mjs --update

# Assert no regressions
node eval/run.mjs

# Run only one suite
node eval/run.mjs --suite suggest_checks
```

## Regression policy

A case **fails** when any of the following change without a corresponding
`--update` call:

- A top-level key disappears from the structured output.
- A required field changes type (e.g. `string[]` → `string`).
- An item count decreases below the snapshot count.

Text content changes are **not** failures — only schema shape and
field presence matter at baseline.

## Adding a new case

1. Create `eval/cases/<tool>/<case-name>.input.json`.
2. Run `node eval/run.mjs --update --suite <tool>`.
3. Commit both files together.
