# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-09-01

### Added
- New `visual_review` core MCP tool for capturing a running local web app and returning responsive PNG screenshots directly to the model for UX/UI evaluation.
- Responsive presets for wide desktop, desktop, laptop, tablet, mobile, and compact mobile, plus bounded custom viewport support.
- Local Chrome, Edge, and Chromium discovery with optional `AGENTIC_BROWSER_EXECUTABLE` override and local-development URL enforcement.
- Real-browser regression coverage for screenshot capture and image delivery through the MCP response pipeline.

### Changed
- The public tool-response finalizer now preserves MCP image content while keeping base64 image payloads out of `structuredContent`, avoiding duplicate large binary payloads.
- The default visual review suite captures desktop, laptop, tablet, and mobile breakpoints so responsive behavior can be compared in one tool call.

## [1.6.0] - 2026-08-11

### Added
- Configurable command security modes: `safe` (default), `trusted`, and `full`, propagated across shell execution, package scripts, tournament execution, risk assessment, CLI configuration, model instructions, and documentation.
- Trusted mode permits inline Node/Python execution and shell file-writing constructs while retaining destructive-command protections; full mode can bypass command-policy rules while OAuth and workspace/file-tool boundaries remain enforced.

### Changed
- Coding workflows now use proportional QUICK / STANDARD / CRITICAL guidance instead of full PVDL orchestration for every edit; strict PVDL remains an explicit override.
- Verification is proportional to change scope: QUICK work is cheap-first, while build and broader suites remain required for build-sensitive, release, and higher-risk changes.
- Assistant discovery now stops once a sufficiently strong implementation target is known, avoiding broad context/bootstrap work for explicit file targets and reducing cross-tool schema fan-out.
- `read_many` now defaults to a 12,000-token budget while still allowing explicit larger budgets when broad context is intentional.
- Fast task context bounds large code regions to 160-line anchor windows, recommends an 8,000-token follow-up read budget, and keeps workspace file-index snapshots warm for 60 seconds across normal reasoning gaps.
- In `AGENTIC_WIDGETS=changes`, single-file `edit`/`write` mutations now carry their review widget directly; aggregate `show_changes` remains available for multi-file, patch/shell/external mutations and explicit aggregate review.

### Fixed
- `.agentic/knowledge` entries are no longer classified as executable workspace instructions by task context.
- Workspace file-index snapshots are invalidated immediately when a write creates a new file.
- Safe-mode command matching now covers aliases such as `python.exe`, versioned Python executables, `py -3`, and `node.exe` consistently.

### Performance
- On the Radar Energético `Parametros.tsx` case, fast task context now recommends two bounded 160-line regions instead of a 1,532-line component body; direct branch measurements were 149 ms cold, 6 ms warm, and 3.4 ms warm.
- QUICK single-file edits no longer pay a redundant aggregate-review round trip, removing roughly 0.5–1.0 s of measured Windows server work plus tunnel latency in the observed workflow.

## [1.5.0] - 2026-08-07

### Added
- Uniform public MCP response envelopes for every tool, including
  `open_workspace`, with `status`, `data`, `error`, `diagnostics` and `metrics`.
- Runtime contract coverage for workspace opening, native doctor diagnostics,
  missing-file errors and attempts to read outside the workspace root.
- Deterministic semantic candidate ranking with explicit-path priority,
  boundary-aware matching and balanced lexical signals.
- Goal-based verification discovery for workspaces without local Git metadata.
- Domain-sensitive staged verification for concurrency, leases, locks,
  authentication, transactions and migrations when related tests and declared
  scripts are available.

### Changed
- `suggest_checks` now distinguishes `actual_changes` from `goal_discovery`,
  rejects Git metadata inherited from ancestor repositories and reports
  environmental limitations without executing setup steps.
- Verification recommendations are staged as `initial`,
  `after_initial_success` and `before_release`, while continuing to exclude
  mutating or undeclared scripts.
- Atomic writes now reserve a same-directory UUID temporary file exclusively,
  synchronize contents, rename atomically and clean up in `finally`.
- `agentic_doctor` returns native structured data instead of serializing JSON
  inside `data.result`.
- `npm run eval` now builds required artifacts before evaluation; workflows that
  already built the project can use `npm run eval:built`.
- The supported Node runtime now starts at `22.19.0`, matching the effective
  minimum required by runtime dependencies and CI/release validation.
- The Pi coding primitives are pinned to the audited security fork
  `@hugolsramos01-bit/pi-coding-agent@0.80.7-agentic.1`, based on upstream
  `0.80.7` with package identity, dependency, lock tooling and generated-lock
  corrections, without runtime behavior changes.
- The MCP SDK is pinned to `1.30.0`, and CI/release gates now audit both the
  source production tree and the package installed from the generated tarball.

### Fixed
- Atomic creation and editing of allowed dotfiles such as `.gitignore`,
  `.prettierrc`, `.eslintrc`, `.editorconfig` and `.env.example`, while keeping
  `.env` and `.npmrc` protected by the secret policy.
- Public error, diagnostic and metadata payloads no longer expose absolute
  workspace paths, including arbitrary string fields such as `stdout`, `stderr`,
  `result`, `output` and `details`; requested relative paths remain available.
- Lockfiles no longer trigger concurrency-domain verification by filename.
- Goal-based verification without Git now infers the effective task type before
  calculating risk, including multi-file refactor scope.
- File reads containing command-like JSON are no longer misclassified as
  failed command executions.
- Explicitly referenced files are no longer demoted behind inferred candidates.
- Grep-derived ranking signals are balanced before result caps are applied.
- CLI Node compatibility now derives from `package.json` instead of a duplicated
  hard-coded range.
- Production tarballs no longer install the vulnerable `undici`,
  `brace-expansion`, `fast-uri`, `ip-address` or `protobufjs` versions found
  during the release audit.

## [1.4.0] - 2026-07-30

### Added
- Deterministic candidate hygiene and candidate eligibility metadata.
- Pre-budget RiskProfile with risk level, score, confidence, factors,
  dependency coverage and estimated blast radius.
- Risk-adaptive VerificationPlan for suggest_checks.
- Verification stages: initial, after_initial_success and before_release.
- Support for actual changed paths and goal-based discovery planning.
- Robust Git porcelain parsing for staged, unstaged, untracked and renamed files.

### Changed
- suggest_checks now returns deterministic advisory verification plans.
- Risk and verification policies account for sensitive configuration,
  fan-out, test proximity and analysis confidence.
- Workspace-scoped legacy verification remains available during the
  compatibility transition.

### Deprecated
- suggest_checks paths, scope and level legacy options.
  Use changedPaths, goal, taskType and focusPaths.

## [1.3.1] - 2026-07-29

### Fixed
- Fixed skeletal compression leakage exposing absolute paths in headers by decoupling `cacheKey` and `displayPath` internally.
- Implemented robust read failure sanitization via `safeReadFailure` to prevent leakage of internal paths.
- Included output integrity guarantees for atomic mutation with before/after hashes natively generated in mutation receipts.
- Decoupled `test:runtime:built` script to run tests without mandatory recompilation, leaving `test:runtime` as the safe default that always builds first.

## [1.3.0] - 2026-07-28

### Added
- Added full support for directory scoping in `task_context` using dual-universe logic (`discovery` vs `supporting`).
- Added robust `.tgz` handling in test-runtime scripts.

### Fixed
- Fixed bug in `classifyCandidateKind` where any file ending with `d.ts` (e.g. `valid.ts`) was misclassified as configuration.
- Fixed dependency filter bugs in `task_context` directly evaluating exclusion paths against internal dependencies arrays.

## [1.2.2] - 2026-07-28

### Fixed
- Fixed unit tests for `read_many` which were broken by the new `isError` schema logic.

## [1.2.1] - 2026-07-28

### Fixed
- Hotfix: Resolved runtime blockers in `read_many`, `edit`, and `apply_patch` caused by ESM/CJS incompatibility and error propagation.
- Fixed `task_context` path scoping logic causing false negatives in testing.
- Fixed `apply_patch` regex and input parsing format to accurately enforce the pre-condition `ifMatch`.

## [1.2.0] - 2026-07-28

### Added
- Feature: **Code Region Context (P3)**. Extractor now supports TS, TSX, JS, JSX, MTS, CTS, MJS and CJS. Extracts classes, functions, methods, interfaces, types, enums and variables.
- Feature: Added `items` array parameter to `read_many` allowing targeted reading of specific regions or line ranges to respect the context budget (max 512 KB, max 2 regions per file).
- Feature: `task_context` now supports Code Region Context for granular visibility, ranking candidate regions dynamically according to the objective.

### Fixed
- Fixed task_context hot path with Quality Guards and Candidate Hygiene.
- Fixed `read_many` deduplication of stat/read per canonical path with internal caching.

### Changed
- Server hot path optimized, natively handling `structuredContent` and nested/top-level envelopes.
- Buffer deduplication and transactional flush.

## [1.1.4] - 2026-07-22

### Fixed
- Preserve the structured `open_workspace` bootstrap response (`workspaceId`, `root`, `mode`, instructions, skills, and agents) instead of replacing it with the generic MCP envelope.

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
