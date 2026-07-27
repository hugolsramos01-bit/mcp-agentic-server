import { finalizeToolResponse } from "../dist/server/tool-response-finalizer.js";
import { performance } from "perf_hooks";

const scenario = process.argv[2];

const scenarios = {
  'structured-small': {
    toolName: 'read_file',
    content: [{ type: "text", text: JSON.stringify({ status: "success", data: { content: "small text" } }) }],
    structuredContent: { envelope: { status: "success", data: { content: "small text" } } },
    _meta: {},
    hasWidget: false
  },
  'native-structured-small': {
    toolName: 'read_file',
    content: [{ type: "text", text: JSON.stringify({ result: "small text" }) }],
    structuredContent: { result: "small text" },
    hasWidget: false
  },
  'text-json-small': {
    toolName: 'read_file',
    content: [{ type: "text", text: JSON.stringify({ status: "success", data: { content: "small text" } }) }],
    hasWidget: false
  },
  'structured-large': {
    toolName: 'read_file',
    content: [{ type: "text", text: JSON.stringify({ status: "success", data: { content: "A".repeat(100000) } }) }],
    structuredContent: { envelope: { status: "success", data: { content: "A".repeat(100000) } } },
    hasWidget: false
  },
  'text-error': {
    toolName: 'run_command',
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: "Command failed" }) }],
    isError: true,
    hasWidget: false
  },
  'structured-error': {
    toolName: 'run_command',
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: "Command failed" }) }],
    structuredContent: { envelope: { status: "error", error: "Command failed" } },
    isError: true,
    hasWidget: false
  },
  'plain-text-success': {
    toolName: 'run_command',
    content: [{ type: "text", text: "Operation completed successfully" }],
    hasWidget: false
  },
  'structured-with-meta-card': {
    toolName: 'read_file',
    content: [{ type: "text", text: JSON.stringify({ status: "success", data: { content: "hello" } }) }],
    structuredContent: { envelope: { status: "success", data: { content: "hello" } } },
    _meta: { card: { title: "Test" } },
    hasWidget: false
  }
};

const data = scenarios[scenario];
if (!data) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(1);
}

class Instrumentation {
  constructor() {
    this.metrics = {
      jsonParses: 0,
      jsonStringifies: 0,
      truncationWalks: 0,
      fallbackTextReads: 0,
      configLoads: 0,
      dynamicImports: 0
    };
  }
  increment(metric) {
    if (this.metrics[metric] !== undefined) {
      this.metrics[metric]++;
    }
  }
}

async function run() {
  const instrumentation = new Instrumentation();
  const options = {
    toolName: data.toolName,
    startedAt: performance.now(),
    inlineOutputCharacters: 1000,
    hasWidget: data.hasWidget
  };

  const response = {
    content: data.content,
    structuredContent: data.structuredContent,
    _meta: data._meta,
    isError: data.isError
  };

  try {
    // Cold measurement
    const coldStart = performance.now();
    await finalizeToolResponse(response, options, new Instrumentation());
    const coldDuration = performance.now() - coldStart;

    // Warmup
    for (let i = 0; i < 50; i++) {
      await finalizeToolResponse(response, options, new Instrumentation());
    }

    const iterations = 500;
    const runDurations = [];
    
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      await finalizeToolResponse(response, options, instrumentation);
      const e = performance.now();
      runDurations.push(e - s);
    }
    
    runDurations.sort((a, b) => a - b);
    const avgDuration = runDurations.reduce((a, b) => a + b, 0) / iterations;
    const medianDuration = runDurations[Math.floor(iterations / 2)];
    const p95Duration = runDurations[Math.floor(iterations * 0.95)];

    const stats = {
      scenario,
      coldDurationMs: coldDuration,
      avgDurationMs: avgDuration,
      medianDurationMs: medianDuration,
      p95DurationMs: p95Duration,
      metricsPerCall: {}
    };

    for (const [key, value] of Object.entries(instrumentation.metrics)) {
      stats.metricsPerCall[key] = value / iterations;
    }

    console.log(JSON.stringify(stats));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
