import { contentText } from "./tool-utils.js";

export interface ToolResponseFinalizerOptions {
  toolName: string;
  startedAt: number;
  inlineOutputCharacters: number;
  hasWidget: boolean;
}

export interface FinalizerInstrumentation {
  increment(
    metric:
      | "jsonParses"
      | "jsonStringifies"
      | "truncationWalks"
      | "fallbackTextReads"
      | "configLoads"
      | "dynamicImports",
  ): void;
}

/**
 * P2.0 Baseline: exact same logic as before, preserving dynamic imports
 * and repetitive parsing. We will optimize this in subsequent commits.
 */
export async function finalizeToolResponse(
  response: any,
  options: ToolResponseFinalizerOptions,
  instrumentation?: FinalizerInstrumentation,
): Promise<any> {
  const { toolName, startedAt, inlineOutputCharacters, hasWidget } = options;

  if (toolName === "open_workspace") return response;

  if (instrumentation) instrumentation.increment("fallbackTextReads");
  const text = contentText(response.content ?? []);
  
  let parsed: any = text;
  try { 
    if (instrumentation) instrumentation.increment("jsonParses");
    parsed = JSON.parse(text); 
  } catch {}

  const existing = response.structuredContent?.envelope
    ?? (parsed && typeof parsed === "object" && "status" in parsed && "data" in parsed ? parsed : undefined);
  const status = existing?.status ?? (response.isError ? "error" : "success");

  if (instrumentation) instrumentation.increment("dynamicImports");
  const { loadConfig: _lc } = await import("../config.js");
  if (instrumentation) instrumentation.increment("configLoads");
  // Still reading from disk for the baseline to match current behavior accurately
  const inlineCap = _lc().inlineOutputCharacters;

  if (instrumentation) instrumentation.increment("dynamicImports");
  const { truncatePayloadWithMetrics } = await import("./tool-utils.js");

  const basePolicy = {
    defaultStringLimit: inlineCap,
    hardStringLimit: 64000,
  };
  
  let policy: any = { ...basePolicy };
  if (toolName === "git_diff" || toolName === "show_changes") {
    policy.fieldLimits = { "diff": 32000, "patch": 32000 };
  } else if (toolName === "apply_patch") {
    policy.fieldLimits = { "preview": 32000 };
  }

  const rawData = existing?.data ?? (status === "error" && typeof parsed === "string" ? {} : parsed);
  
  if (instrumentation) instrumentation.increment("truncationWalks");
  const { payload: data, metrics: truncMetrics } = truncatePayloadWithMetrics(rawData, policy);

  const wasTruncated = truncMetrics.totalTruncatedFields > 0 || Boolean(response._meta?.truncated || text.includes("[truncated]") || text.includes("... [truncated"));

  const envelope = {
    status,
    data,
    error: existing?.error ?? (status === "error" ? (typeof parsed === "string" ? parsed : parsed?.error ?? parsed?.message ?? JSON.stringify(parsed)) : null),
    diagnostics: existing?.diagnostics ?? [],
    metrics: {
      durationMs: existing?.metrics?.durationMs ?? Math.round(performance.now() - startedAt),
      truncated: wasTruncated,
      omittedCharacters: truncMetrics.omittedCharacters,
    },
  };

  const errorPreview = status === "error" && envelope.error
    ? (() => { const t = String(envelope.error).replace(/\s+/g, " ").trim(); return t.length > 240 ? t.slice(0, 237) + "..." : t; })()
    : undefined;
  const errorSuffix = errorPreview ? ` — ${errorPreview}` : "";

  const { _meta: _origMeta, ...responseBody } = response;
  const responseMeta = _origMeta;
  const sanitizedMeta =
    !hasWidget && responseMeta?.card
      ? Object.fromEntries(Object.entries(responseMeta).filter(([k]) => k !== "card"))
      : responseMeta;

  if (instrumentation) instrumentation.increment("jsonStringifies");
  const finalSummaryText = `${toolName}: ${status}${errorSuffix} (${JSON.stringify(envelope).length} chars, ${envelope.metrics.durationMs}ms)`;

  return {
    ...responseBody,
    ...(sanitizedMeta && Object.keys(sanitizedMeta).length > 0 ? { _meta: sanitizedMeta } : {}),
    content: [{ type: "text" as const, text: finalSummaryText }],
    isError: status === "error",
    structuredContent: { envelope }
  };
}
