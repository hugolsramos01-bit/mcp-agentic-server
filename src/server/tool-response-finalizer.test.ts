import { test } from "node:test";
import assert from "node:assert";
import { finalizeToolResponse, FinalizerInstrumentation } from "./tool-response-finalizer.js";

function createMockInstrumentation(): FinalizerInstrumentation & { counts: Record<string, number> } {
  const counts: Record<string, number> = {
    jsonParses: 0,
    jsonStringifies: 0,
    truncationWalks: 0,
    fallbackTextReads: 0,
    configLoads: 0,
    dynamicImports: 0
  };
  return {
    counts,
    increment(metric: any) {
      counts[metric]++;
    }
  } as any;
}

const defaultOptions = {
  toolName: "test_tool",
  startedAt: performance.now(),
  inlineOutputCharacters: 100,
  hasWidget: false,
};

test("nested envelope", () => {
  const instr = createMockInstrumentation();
  const response = {
    structuredContent: {
      envelope: { status: "success", data: { foo: "bar" }, error: null }
    }
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 0, "Should not parse JSON");
  assert.strictEqual(instr.counts.fallbackTextReads, 0, "Should not read fallback text");
  assert.deepStrictEqual(result.structuredContent.data, { foo: "bar" });
  assert.strictEqual(result.structuredContent.status, "success");
});

test("legacy result/envelope wrapper is collapsed without duplicating data", () => {
  const instr = createMockInstrumentation();
  const taskContextData = {
    version: 1,
    primaryFiles: [{ path: "src/auth.ts" }],
    supportingFiles: [],
  };
  const response = {
    structuredContent: {
      result: JSON.stringify(taskContextData),
      envelope: taskContextData,
    },
  };

  const result = finalizeToolResponse(response, defaultOptions, instr);

  assert.deepStrictEqual(result.structuredContent.data, taskContextData);
  assert.equal("result" in result.structuredContent.data, false);
  assert.equal("envelope" in result.structuredContent.data, false);
  assert.strictEqual(instr.counts.jsonParses, 0, "Structured data must not be reparsed");
});

test("native structured data", () => {
  const instr = createMockInstrumentation();
  const response = {
    structuredContent: { result: "native data" }
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 0, "Should not parse JSON");
  assert.strictEqual(instr.counts.fallbackTextReads, 0, "Should not read fallback text");
  assert.strictEqual(result.structuredContent.data.result, "native data");
});

test("text JSON", () => {
  const instr = createMockInstrumentation();
  const response = {
    content: [{ type: "text", text: JSON.stringify({ status: "success", data: { ok: true } }) }]
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 1, "Should parse JSON exactly once");
  assert.strictEqual(instr.counts.fallbackTextReads, 1, "Should read fallback text exactly once");
  assert.deepStrictEqual(result.structuredContent.data, { ok: true });
});

test("plain text", () => {
  const instr = createMockInstrumentation();
  const response = {
    content: [{ type: "text", text: "plain old text" }]
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 1, "Should attempt to parse JSON once");
  assert.strictEqual(result.structuredContent.data, "plain old text");
  assert.strictEqual(result.structuredContent.status, "success");
});

test("structured error", () => {
  const instr = createMockInstrumentation();
  const response = {
    structuredContent: {
      envelope: { status: "error", data: {}, error: "something failed" }
    },
    isError: true
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 0, "Should not parse JSON");
  assert.strictEqual(result.structuredContent.status, "error");
  assert.strictEqual(result.structuredContent.error, "something failed");
  assert.strictEqual(result.isError, true);
});

test("text error", () => {
  const instr = createMockInstrumentation();
  const response = {
    content: [{ type: "text", text: "this is an error message" }],
    isError: true
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  assert.strictEqual(instr.counts.jsonParses, 1, "Should attempt to parse JSON");
  assert.strictEqual(result.structuredContent.status, "error");
  assert.strictEqual(result.structuredContent.error, "this is an error message");
  assert.deepStrictEqual(result.structuredContent.data, {});
  assert.strictEqual(result.isError, true);
});

test("native command failure becomes an error envelope", () => {
  const instr = createMockInstrumentation();
  const response = {
    structuredContent: {
      status: "failed",
      exitCode: 2,
      message: "typecheck failed",
    },
  };

  const result = finalizeToolResponse(
    response,
    { ...defaultOptions, toolName: "run_package_script" },
    instr,
  );

  assert.strictEqual(result.structuredContent.status, "error");
  assert.strictEqual(result.structuredContent.error, "typecheck failed");
  assert.strictEqual(result.isError, true);
});

test("read content containing command-like JSON remains successful", () => {
  const instr = createMockInstrumentation();
  const fileContent = '{"status":"failed","exitCode":2,"message":"fixture text"}';
  const response = {
    structuredContent: {
      result: fileContent,
      file: {
        path: "fixtures/command-result.json",
        contentHash: "sha256:fixture",
        sizeBytes: fileContent.length,
      },
    },
  };

  const result = finalizeToolResponse(
    response,
    { ...defaultOptions, toolName: "read" },
    instr,
  );

  assert.strictEqual(result.structuredContent.status, "success");
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.structuredContent.error, null);
  assert.strictEqual(result.structuredContent.data.result, fileContent);
});

test("widget meta preserved", () => {
  const instr = createMockInstrumentation();
  const response = {
    _meta: { ui: { resourceUri: "foo" } },
    structuredContent: { result: "ok" }
  };
  const result = finalizeToolResponse(response, { ...defaultOptions, hasWidget: true }, instr);
  assert.deepStrictEqual(result._meta, { ui: { resourceUri: "foo" } });
});

test("non-widget card removed", () => {
  const instr = createMockInstrumentation();
  const response = {
    _meta: { card: { type: "markdown", value: "hello" }, other: true },
    structuredContent: { result: "ok" }
  };
  const result = finalizeToolResponse(response, { ...defaultOptions, hasWidget: false }, instr);
  assert.deepStrictEqual(result._meta, { other: true });
  assert.strictEqual(result._meta.card, undefined);
});

test("large payload truncation", () => {
  const instr = createMockInstrumentation();
  const largeText = "a".repeat(200);
  const response = {
    structuredContent: { large: largeText }
  };
  const result = finalizeToolResponse(response, { ...defaultOptions, inlineOutputCharacters: 10 }, instr);
  const outputData = result.structuredContent.data.large;
  assert.ok(outputData.includes("[200 characters omitted]"), "Output should be truncated");
  assert.strictEqual(result.structuredContent.metrics.truncated, true);
  assert.ok(result.structuredContent.metrics.omittedCharacters > 0);
});

test("top-level outputSchema shape", () => {
  const instr = createMockInstrumentation();
  const response = {
    structuredContent: { result: "hello" }
  };
  const result = finalizeToolResponse(response, defaultOptions, instr);
  
  // ensure the final structuredContent is exactly the envelope
  const sc = result.structuredContent;
  assert.ok("status" in sc);
  assert.ok("data" in sc);
  assert.ok("error" in sc);
  assert.ok("diagnostics" in sc);
  assert.ok("metrics" in sc);
  assert.strictEqual(sc.data.result, "hello");
});
