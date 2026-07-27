export type TaskType =
  | "auto"
  | "bug_fix"
  | "feature"
  | "refactor"
  | "security_review"
  | "migration"
  | "frontend"
  | "release";

export type EvidenceType =
  | "focus_path"
  | "extracted_path"
  | "filename_exact"
  | "filename_partial"
  | "content_match"
  | "route"
  | "schema"
  | "import"
  | "test_proximity"
  | "task_type";

export interface EvidenceEntry {
  type: EvidenceType;
  detail: string;
}

export type Confidence = "low" | "medium" | "high";

export type TaskFileRole = 
  | "primary"
  | "dependency"
  | "test"
  | "configuration"
  | "instruction"
  | "supporting";

export interface TaskFileCandidate {
  path: string;
  role: TaskFileRole;
  confidence: Confidence;
  evidence: EvidenceEntry[];
  recommendedReadTool: "read" | "read_adaptive" | "read_many";
}

export type TaskContextDepth = "fast" | "balanced" | "deep";

import type { PerformanceRecorder } from "../performance/performance-recorder.js";

export interface TaskContextInput {
  workspaceId: string;
  cwd: string;
  allowedRoots: string[];
  goal: string;
  type?: TaskType;
  focusPaths?: string[];
  excludePaths?: string[];
  maxTokens?: number;
  instructionFiles?: string[];
  depth?: TaskContextDepth;
  perf?: PerformanceRecorder;
}

export interface TaskContextResult {
  version: 1;
  goal: string;
  taskType: TaskType;
  taskTypeSource: "explicit" | "inferred" | "default";
  
  requestedDepth?: TaskContextDepth;
  effectiveDepth: TaskContextDepth;
  depthSource: "explicit" | "inferred" | "default";
  
  primaryFiles: TaskFileCandidate[];
  supportingFiles: TaskFileCandidate[];
  
  directDependents: Array<{
    source: string;
    dependents: string[];
    confidence: Confidence;
    limitations: string[];
  }>;
  
  applicableInstructions: Array<{
    path: string;
    scope: string;
    reason: string;
  }>;
  
  nearbyTestCandidates: Array<{
    sourcePath: string;
    testPaths: string[];
  }>;
  
  suggestedNextSteps: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    reason: string;
  }>;
  
  limitations: string[];
  
  budget: {
    maxTokens: number;
    estimatedTokens: number;
    truncated: boolean;
    omittedCandidates: number;
  };
}
