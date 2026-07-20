# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.20] - 2026-07-20

### Fixed
- Publish releases with the configured npm automation token when npm Trusted Publishing provenance is not configured.

## [1.0.19] - 2026-07-20

### Fixed
- Store checkpoints outside linked Git worktrees, verify restored file hashes, and cover recovery with an integrated worktree test.
- Capture the `show_changes` baseline before workspace opening returns so the first newly-created file cannot be omitted.
- Verify native worktree dependencies through the target worktree resolver instead of `node -e`; lifecycle scripts require explicit opt-in.
- Align documentation and standard model instructions with canonical tool names and hide deprecated aliases from the default workflow.

## [1.0.18] - 2026-07-20

### Fixed
- Corrected release artifact smoke-test path and removed inline Node evaluation from the release workflow.

## [1.0.17] - 2026-07-20

### Added
- True skeletal compression outlines with regression coverage for meaningful token savings.
- FastAPI discovery in semantic packs, including entrypoints, routers, and decorated routes.
- Native dependency runtime verification option for `worktree_install_deps` and a package smoke command.

### Fixed
- Replaced the policy-blocked `node -e` build cleanup with a dedicated script.
- Made v2 checkpoint restoration independent of a legacy `patch.diff` file.
- Corrected `show_changes` operation classification and made Payload output use one canonical field tree.
- Removed textual filename fallback from `file_dependencies` to avoid false dependency reports.
- Exposed `risk_assess_command` and hid deprecated aliases unless `AGENTIC_LEGACY_ALIASES=1` is set.

## [1.0.16] - 2026-07-17

### Added
- Cross-platform Process Runner with normalized execution results and Windows package-manager shim support.
- `agentic_doctor` MCP diagnostics and an automated tag-driven npm release workflow with package smoke testing.
- Explicit `allowParentGitRoot` opt-in for worktree creation when a requested directory belongs to a parent Git repository.

### Fixed
- Distinguished command, infrastructure, dependency, policy, timeout, and missing-script outcomes in package scripts and tournament verification.
- Made tournament cleanup truthful, force-capable, and stateful when preserving a winner.
- Prevented implicit worktree scope expansion to a parent repository.
- Stabilized Windows npm, pnpm, and yarn execution without a `cmd.exe` shell wrapper.
- Improved checkpoint restoration, current-workspace change reporting, Payload schema hierarchy, and framework capability diagnostics.

## [1.0.4] - 2026-07-14

### Added
- True Git Worktree Sandboxing for `open_workspace`.
- Semantic AST Navigation (`coding_context`, `next_route_map`, `payload_schema_map`).
- Security hardening: blocked LLM access to `.env` and `.pem` files.
- `assistant` tool mode is now the default for enhanced LLM usage.

### Fixed
- Fixed context bloat by trimming file contents in semantic packs when exceeding context limit.
- Fixed multi-line import parsing in safe file preview.

### Changed
- Standardized Node requirement to `>=22.12.0 <27`.
- Switched project to strict `npm` tracking.
- Consolidated naming to Agentic MCP Server.
