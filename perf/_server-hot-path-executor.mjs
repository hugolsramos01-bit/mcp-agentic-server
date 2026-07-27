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

  // Warmup run
  await finalizeToolResponse(response, options, new Instrumentation());

  const iterations = 100;
  const start = performance.now();
  
  let result;
  for (let i = 0; i < iterations; i++) {
    result = await finalizeToolResponse(response, options, instrumentation);
  }
  
  const end = performance.now();
  const avgDuration = (end - start) / iterations;

  // Print normalized metrics per call
  console.log(`Results for ${scenario}:`);
  console.log(`  Average Latency: ${avgDuration.toFixed(3)}ms`);
  console.log(`  Metrics (per call):`);
  for (const [key, value] of Object.entries(instrumentation.metrics)) {
    console.log(`    - ${key}: ${value / iterations}`);
  }
}

run().catch(console.error);
