import { ToolPerformanceMetrics } from "./performance-types.js";
import { PhaseTimer, NOOP_PHASE_TIMER, ActivePhaseTimer } from "./phase-timer.js";

export interface PerformanceRecorder {
  readonly enabled: boolean;
  increment(
    metric: "subprocessCount" | "filesystemReads" | "filesystemStats" | "sqliteReads" | "sqliteWrites" | "cacheHits" | "cacheMisses",
    amount?: number
  ): void;
  startPhase(name: string): PhaseTimer;
  finish(resultInfo?: { outputCharacters?: number; estimatedOutputTokens?: number }): ToolPerformanceMetrics | undefined;
}

const PERF_ENABLED = process.env.AGENTIC_PERF === "1";

export const NOOP_PERFORMANCE_RECORDER: PerformanceRecorder = {
  enabled: false,
  increment() {},
  startPhase() {
    return NOOP_PHASE_TIMER;
  },
  finish() {
    return undefined;
  },
};

export class ActivePerformanceRecorder implements PerformanceRecorder {
  readonly enabled = true;
  private readonly metrics: ToolPerformanceMetrics;
  private readonly startTime: number;
  private isFinished = false;

  constructor(tool: string, workspaceId?: string) {
    this.startTime = performance.now();
    this.metrics = {
      tool,
      workspaceId,
      durationMs: 0,
      outputCharacters: 0,
      estimatedOutputTokens: 0,
      subprocessCount: 0,
      filesystemReads: 0,
      filesystemStats: 0,
      sqliteReads: 0,
      sqliteWrites: 0,
      cacheHits: 0,
      cacheMisses: 0,
      phases: {},
    };
  }

  increment(
    metric: "subprocessCount" | "filesystemReads" | "filesystemStats" | "sqliteReads" | "sqliteWrites" | "cacheHits" | "cacheMisses",
    amount = 1
  ): void {
    if (!this.isFinished) {
      this.metrics[metric] += amount;
    }
  }

  startPhase(name: string): PhaseTimer {
    if (this.isFinished) {
      return NOOP_PHASE_TIMER;
    }
    return new ActivePhaseTimer(name, (phaseName, durationMs) => {
      if (!this.isFinished) {
        this.metrics.phases[phaseName] = (this.metrics.phases[phaseName] || 0) + durationMs;
      }
    });
  }

  finish(resultInfo?: { outputCharacters?: number; estimatedOutputTokens?: number }): ToolPerformanceMetrics | undefined {
    if (this.isFinished) return this.metrics;
    
    this.metrics.durationMs = performance.now() - this.startTime;
    if (resultInfo?.outputCharacters !== undefined) {
      this.metrics.outputCharacters = resultInfo.outputCharacters;
    }
    if (resultInfo?.estimatedOutputTokens !== undefined) {
      this.metrics.estimatedOutputTokens = resultInfo.estimatedOutputTokens;
    }
    
    this.isFinished = true;
    return this.metrics;
  }
}

export function startToolPerformance(tool: string, workspaceId?: string): PerformanceRecorder {
  return PERF_ENABLED ? new ActivePerformanceRecorder(tool, workspaceId) : NOOP_PERFORMANCE_RECORDER;
}
