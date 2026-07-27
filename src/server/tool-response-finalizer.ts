import { contentText, truncatePayloadWithMetrics } from "./tool-utils.js";

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
 * P2.1+ Otimizado: sem imports dinâmicos e recebendo config no startup.
 */
function isEnvelope(value: any): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    "data" in value
  );
}

export function finalizeToolResponse(
  response: any,
  options: ToolResponseFinalizerOptions,
  instrumentation?: FinalizerInstrumentation,
): any {
  const { toolName, startedAt, inlineOutputCharacters, hasWidget } = options;

  if (toolName === "open_workspace") return response;

  const structured = response.structuredContent;

  const existingEnvelope =
    isEnvelope(structured?.envelope)
      ? structured.envelope
      : isEnvelope(structured)
        ? structured
        : undefined;

  const status = existingEnvelope?.status ?? (response.isError ? "error" : "success");

  let parsedFromText: any;
  let rawData: any;
  let text: string | undefined;

  if (existingEnvelope) {
    rawData = existingEnvelope.data;
  } else if (structured !== undefined) {
    // Structured data nativo da ferramenta.
    rawData = structured;
  } else {
    if (instrumentation) instrumentation.increment("fallbackTextReads");

    text = contentText(response.content ?? []);
    parsedFromText = text;

    try {
      if (instrumentation) instrumentation.increment("jsonParses");
      parsedFromText = JSON.parse(text);
    } catch {
      // Texto simples é um fallback válido.
    }

    rawData =
      status === "error" && typeof parsedFromText === "string"
        ? {}
        : parsedFromText;
  }

  const basePolicy = {
    defaultStringLimit: inlineOutputCharacters,
    hardStringLimit: 64000,
  };
  
  let policy: any = { ...basePolicy };
  if (toolName === "git_diff" || toolName === "show_changes") {
    policy.fieldLimits = { "diff": 32000, "patch": 32000 };
  } else if (toolName === "apply_patch") {
    policy.fieldLimits = { "preview": 32000 };
  }

  if (instrumentation) instrumentation.increment("truncationWalks");
  const { payload: data, metrics: truncMetrics } = truncatePayloadWithMetrics(rawData, policy);

  const wasTruncated = truncMetrics.totalTruncatedFields > 0 || Boolean(response._meta?.truncated || (text && (text.includes("[truncated]") || text.includes("... [truncated"))));

  const envelopeError = existingEnvelope?.error ?? (status === "error" ? (typeof parsedFromText === "string" ? parsedFromText : parsedFromText?.error ?? parsedFromText?.message ?? JSON.stringify(parsedFromText)) : null);

  const envelope = {
    status,
    data,
    error: envelopeError,
    diagnostics: existingEnvelope?.diagnostics ?? [],
    metrics: {
      durationMs: existingEnvelope?.metrics?.durationMs ?? Math.round(performance.now() - startedAt),
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
    structuredContent: envelope
  };
}
