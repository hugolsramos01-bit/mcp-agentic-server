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

function legacyWrappedData(value: any): any | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.result !== "string" ||
    !value.envelope ||
    typeof value.envelope !== "object" ||
    isEnvelope(value.envelope)
  ) {
    return undefined;
  }

  return value.envelope;
}

const COMMAND_RESULT_TOOLS = new Set([
  "bash",
  "run_package_script",
  "worktree_install_deps",
]);

function detectCommandFailure(value: any): string | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value) return detectCommandFailure(parsed);
    } catch {
      // Some legacy tools return command JSON as plain text.
    }

    if (/"status"\s*:\s*"failed"/i.test(value)) {
      return "Command reported status=failed";
    }
    const exitCodeMatch = value.match(/"exitCode"\s*:\s*(-?\d+)/i);
    if (exitCodeMatch && Number(exitCodeMatch[1]) !== 0) {
      return `Command exited with code ${exitCodeMatch[1]}`;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  if (typeof value.status === "string" && value.status.toLowerCase() === "failed") {
    return value.error ?? value.message ?? "Command reported status=failed";
  }

  const exitCode =
    typeof value.exitCode === "number"
      ? value.exitCode
      : typeof value.exitCode === "string"
        ? Number(value.exitCode)
        : undefined;
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    return value.error ?? value.message ?? `Command exited with code ${exitCode}`;
  }

  if (typeof value.result === "string") {
    return detectCommandFailure(value.result);
  }

  return undefined;
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
  const legacyData = existingEnvelope ? undefined : legacyWrappedData(structured);

  let parsedFromText: any;
  let rawData: any;
  let text: string | undefined;

  let finalStatus = response.isError ? "error" : "success";

  if (existingEnvelope) {
    finalStatus = existingEnvelope.status;
    rawData = existingEnvelope.data;
  } else if (legacyData !== undefined) {
    rawData = legacyData;
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

    if (isEnvelope(parsedFromText)) {
      finalStatus = parsedFromText.status;
      rawData = parsedFromText.data;
      parsedFromText = parsedFromText.error; // hold error if any
    } else {
      rawData =
        finalStatus === "error" && typeof parsedFromText === "string"
          ? {}
          : parsedFromText;
    }
  }

  const commandFailure =
    finalStatus === "success" && COMMAND_RESULT_TOOLS.has(toolName)
      ? detectCommandFailure(rawData)
      : undefined;
  if (commandFailure) {
    finalStatus = "error";
    parsedFromText = commandFailure;
  }

  const status = finalStatus;

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

  const envelopeError = existingEnvelope?.error ?? (status === "error" ? (commandFailure ?? (typeof parsedFromText === "string" ? parsedFromText : parsedFromText?.error ?? parsedFromText?.message ?? JSON.stringify(parsedFromText))) : null);
  const nativeDiagnostics =
    !existingEnvelope && Array.isArray(rawData?.diagnostics)
      ? rawData.diagnostics
      : [];

  const envelope = {
    status,
    data,
    error: envelopeError,
    diagnostics: existingEnvelope?.diagnostics ?? nativeDiagnostics,
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
