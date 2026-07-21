# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.3] - 2026-07-21

### Fixed
- Normalize the MCP response envelope at the tool registration boundary so every tool mode matches the declared `status`, `data`, `error`, `diagnostics`, and `metrics` contract.
- Mark Payload schema extraction as partial when a `fields` expression is dynamic rather than silently reporting full coverage.
- Apply dependency graph limits to direct, transitive, and inward dependency analysis and report the actual files examined.

## [1.1.2] - 2026-07-21

### Added
- Feature: Implementada Verificação Pós-Instalação em `worktree_install_deps` validando a criação física de `node_modules` e `.lock` files.
- Feature: O Payload CMS Schema Mapper (`payload_schema_map`) agora suporta AST Honesta, relatando quando `coverage: "partial"` devido a referências não resolvíveis.
- Feature: `file_dependencies` agora suporta os argumentos `maxDepth`, `maxFiles`, `maxDependencies`, `includeTransitive` e `summaryOnly` para reduzir o tamanho dos metadados extraídos.

### Changed
- Refactor: Padronizado o Contrato de Respostas do MCP (MCP Envelope) usando `wrap()`, removendo o encapsulamento interno redundante e unificando o modelo de respostas `{status, data, error, diagnostics, metrics}`.
- Refactor: `workspace_summary` migrado de um "alias deprecado" para a ferramenta canônica de descobertas e sumários enxutos.
- Refactor: Massiva melhoria Anti-bloat em `project_bootstrap` e `treeTool` injetando filtros globais para ignorar diretórios como `.next`, `.cache`, e binários/multimídia.

## [1.1.1] - 2026-07-21

### Fixed
- Increase `run_package_script` timeout to 10 minutes to properly accommodate long build processes.
- Fix `payload_schema_map` AST traversal that incorrectly duplicated fields by re-entering nested array declarations.

## [1.1.0] - 2026-07-21

### Added
- Feature: Comprehensive `import-resolver` using TypeScript Compiler API, handling `tsconfig` extends, aliases, and dependency cycle detection.
- Feature: Semantic tools now detect React/Vite setups, configurations, and Monorepo workspace boundaries.
- Feature: Payload CMS schema mapper now supports `summary`, `compact`, and `full` detail modes to manage context budgets.

### Fixed
- Hardened tournament judge failure propagation, ensuring missing dependencies and infrastructure errors are faithfully reported in diagnostics.

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
