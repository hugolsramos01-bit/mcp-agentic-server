export const TOOL_CONTRACTS = {
  read: {
    title: "Read File",
    description: "Read one already-known file or an exact line range. Best for precise inspection, project instructions, and authoritative pre-change text. Responses are paginated; keep ranges as small as the task allows.",
  },
  readAdaptive: {
    title: "Read File Adaptively",
    description: "Inspect one already-known code file with automatic AST-aware compression based on size. Best for whole-file orientation when exact ranges are not known. Compressed output may omit implementation bodies, so obtain exact source text before changing an omitted region.",
  },
  readCompressed: {
    title: "Read Compressed File",
    description: "Inspect one already-known code file with an explicitly selected AST-compression level. Use when direct control over compression is useful; compressed output may omit implementation details.",
  },
  readMany: {
    title: "Read Many Files",
    description: "Read several already-known files or exact ranges under one shared token budget, optionally with AST-aware compression. Best for comparing related definitions after paths are identified. This is not a discovery operation; oversized inputs may be skipped by the budget guard.",
  },
  grep: {
    title: "Grep Files",
    description: "Search lexically for a known symbol, identifier, string, or pattern without reading complete files. Best for locating declarations or references when the exact line is unknown. It does not infer semantic dependencies or behavioral relationships.",
  },
  semanticPack: {
    title: "Semantic Pack",
    description: "Build a goal-focused architectural overview only when broad domain structure or inter-file relationships are genuinely unknown. Once sufficient implementation targets are known, stop architectural discovery and work from the narrower evidence.",
  },
  taskContext: {
    title: "Task Context",
    description: "Return a minimal, fast, stateless, goal-directed map when the relevant implementation files are not yet known. Discovers primary candidates, nearby tests, and limited dependency evidence within a strict token budget. Skip this discovery step when the target file is already known.",
  },
  codingContext: {
    title: "Coding Context",
    description: "Collect broad project and framework metadata such as monorepo structure, routes, schemas, scripts, and capabilities. Use only when the task actually requires a project-wide framework map.",
  },
  suggestChecks: {
    title: "Suggest Checks",
    description: "Plan proportionate verification after material code or configuration changes when the correct checks are not already obvious. QUICK low-risk work with an evident cheap check does not need an extra planning call. Recommendations are staged cheap-first; builds are reserved for release, build-sensitive, or higher-risk scope. It does not execute checks.",
  }
} as const;
