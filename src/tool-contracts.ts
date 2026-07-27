export const TOOL_CONTRACTS = {
  read: {
    title: "Read File",
    description: "Read one known file or an exact line range. Use for short files, precise inspection, reading project instructions, or retrieving the authoritative text before an edit. Responses are paginated. Do not use for repository discovery or for reading many files; use grep, read_many, or semantic_pack instead.",
  },
  readAdaptive: {
    title: "Read File Adaptively",
    description: "Inspect one known code file using automatic AST-aware compression based on its size. Use as the default for understanding a whole file when exact line ranges are not required. If the result omits code that must be edited, read the relevant range with read before changing it.",
  },
  readCompressed: {
    title: "Read Compressed File",
    description: "Inspect one known code file using an explicitly selected AST-compression level. Use only when you need direct control over compression. Prefer read_adaptive for normal whole-file inspection and read for exact source text.",
  },
  readMany: {
    title: "Read Many Files",
    description: "Read several already-known files under a shared token budget, optionally using AST-aware compression. Use to compare definitions, interfaces, or related modules after the relevant paths have been identified. Files may be skipped when the token budget is exhausted. Do not use this tool to discover which files are relevant.",
  },
  grep: {
    title: "Grep Files",
    description: "Search lexically for a known symbol, identifier, string, or pattern without reading complete files. Use to locate declarations, references, or matching text, then inspect the relevant files with read or read_adaptive. This tool does not infer semantic dependencies or behavioral relationships.",
  },
  semanticPack: {
    title: "Semantic Pack",
    description: "Build a goal-focused architectural overview of a specific domain when the relevant files are not yet known. Use this to discover broad architecture, workflow, and inter-file relationships within a large token budget. Once the primary files are known, prefer grep, read_adaptive, read_many, or task_context for iterative investigation.",
  },
  taskContext: {
    title: "Task Context",
    description: "Returns a minimal, fast, stateless, goal-directed map for a coding task. Discovers primary file candidates, nearby tests, and direct dependents within a strict token budget. Use this as the primary first step to bootstrap a focused coding goal.",
  },
  codingContext: {
    title: "Coding Context",
    description: "Collect broad project and framework metadata, including monorepo structure, routes, schemas, scripts, and project capabilities. Use when the task specifically requires this broad framework map. For goal-directed discovery of relevant files, prefer semantic_pack.",
  },
  suggestChecks: {
    title: "Suggest Checks",
    description: "Plan proportionate verification for the current changes. Use after material code or configuration changes and before concluding a coding task. Follow the returned initial and afterInitialSuccess stages before broader or release-only checks. This tool recommends checks but does not execute them; documentation-only changes may require no code checks.",
  }
} as const;
