# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
