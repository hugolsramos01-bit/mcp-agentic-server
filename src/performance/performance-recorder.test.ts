import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { 
  NOOP_PERFORMANCE_RECORDER, 
  startToolPerformance,
  ActivePerformanceRecorder
} from "./performance-recorder.js";

describe("PerformanceRecorder", () => {
  const originalEnv = process.env.AGENTIC_PERF;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTIC_PERF;
    } else {
      process.env.AGENTIC_PERF = originalEnv;
    }
  });

  it("should return NOOP_PERFORMANCE_RECORDER when AGENTIC_PERF is not 1", () => {
    const recorder = NOOP_PERFORMANCE_RECORDER;
    recorder.increment("subprocessCount");
    const phase = recorder.startPhase("test");
    phase.end();
    const result = recorder.finish();
    assert.equal(result, undefined);
  });

  it("should record metrics when active", () => {
    const recorder = new ActivePerformanceRecorder("test-tool");
    recorder.increment("subprocessCount", 2);
    recorder.increment("filesystemReads");
    
    const phase = recorder.startPhase("init");
    phase.end();
    
    const result = recorder.finish({ outputCharacters: 100 });
    assert.ok(result);
    assert.equal(result.tool, "test-tool");
    assert.equal(result.subprocessCount, 2);
    assert.equal(result.filesystemReads, 1);
    assert.equal(result.outputCharacters, 100);
    assert.ok(result.durationMs >= 0);
    assert.ok(result.phases["init"] >= 0);
  });

  it("should not accumulate after finish", () => {
    const recorder = new ActivePerformanceRecorder("test-tool");
    const result = recorder.finish();
    assert.ok(result);
    
    recorder.increment("subprocessCount");
    assert.equal(result.subprocessCount, 0);
    
    const phase = recorder.startPhase("late");
    phase.end();
    assert.equal(result.phases["late"], undefined);
  });
});
