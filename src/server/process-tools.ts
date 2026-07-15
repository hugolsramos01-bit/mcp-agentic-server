import type { Response } from "express";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProcessSnapshot } from "../process-sessions.js";
import { textBlock, contentText, resultOutputSchema, READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, SHELL_TOOL_ANNOTATIONS } from "./tool-utils.js";
import type { ToolContent, ToolLogFields } from "./tool-utils.js";

export function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

export function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

export function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = { lines: 0, characters: 0 };
  if (snapshot.output) {
    const txt = snapshot.output;
    outputSummary.lines = txt.split("\n").length;
    outputSummary.characters = txt.length;
  }
  return {
    content,
    _meta: {
      tool,
      card: { workspaceId, summary: { ...summary, ...outputSummary }, payload: { content } },
    },
    structuredContent: {
      result, sessionId: snapshot.sessionId, running: snapshot.running,
      exitCode: snapshot.exitCode, signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs, outputTruncated: snapshot.outputTruncated,
    },
  };
}
