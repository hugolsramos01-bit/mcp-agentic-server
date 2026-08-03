import { posix, win32 } from "node:path";
import { contentText, truncatePayloadWithMetrics } from "./tool-utils.js";

export interface PublicPathContext {
  workspaceRoot?: string;
  sourceRoot?: string;
  workspaceAlias?: string;
  requestedPath?: string;
}

export interface ToolResponseFinalizerOptions {
  toolName: string;
  startedAt: number;
  inlineOutputCharacters: number;
  hasWidget: boolean;
  publicPathContext?: PublicPathContext;
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

function isEnvelope(value: any): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      "data" in value,
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

  if (
    typeof value.status === "string" &&
    value.status.toLowerCase() === "failed"
  ) {
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

function pathApi(value: string): typeof win32 {
  return win32.isAbsolute(value) ? win32 : (posix as typeof win32);
}

function isAbsolutePathLike(value: string): boolean {
  return win32.isAbsolute(value) || posix.isAbsolute(value);
}

function relativeInsideRoot(value: string, root: string): string | null {
  const api = pathApi(root);
  if (!api.isAbsolute(value)) return null;

  const relative = api.relative(api.resolve(root), api.resolve(value));
  if (relative === "") return ".";
  if (
    relative === ".." ||
    relative.startsWith(`..${api.sep}`) ||
    api.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.replace(/\\/g, "/");
}

export function sanitizePublicPath(
  value: string,
  context: PublicPathContext = {},
): string {
  if (!value || value.startsWith("~")) return value;

  if (context.workspaceRoot) {
    const relative = relativeInsideRoot(value, context.workspaceRoot);
    if (relative !== null) return relative;
  }

  if (context.sourceRoot) {
    const relative = relativeInsideRoot(value, context.sourceRoot);
    if (relative !== null) {
      return relative === "."
        ? "<source-workspace>"
        : `<source-workspace>/${relative}`;
    }
  }

  if (!isAbsolutePathLike(value)) return value;

  const requestedPath = context.requestedPath?.replace(/\\/g, "/");
  if (requestedPath && !isAbsolutePathLike(requestedPath)) {
    return requestedPath;
  }

  const api = pathApi(value);
  const basename = api.basename(value);
  return basename ? `<absolute-path>/${basename}` : "<absolute-path>";
}

function replaceAllLiteral(
  value: string,
  literal: string,
  replacement: string,
): string {
  if (!literal) return value;
  return value.split(literal).join(replacement);
}

export function sanitizePublicError(
  value: string,
  context: PublicPathContext = {},
): string {
  let sanitized = value;
  const workspaceLabel = context.workspaceAlias
    ? `<workspace:${context.workspaceAlias}>`
    : "<workspace>";

  for (const [root, replacement] of [
    [context.workspaceRoot, workspaceLabel],
    [context.sourceRoot, "<source-workspace>"],
  ] as const) {
    if (!root) continue;
    sanitized = replaceAllLiteral(sanitized, root, replacement);
    sanitized = replaceAllLiteral(
      sanitized,
      root.replace(/\\/g, "/"),
      replacement,
    );
    sanitized = replaceAllLiteral(
      sanitized,
      root.replace(/\//g, "\\"),
      replacement,
    );
  }

  const requestedPath = context.requestedPath?.replace(/\\/g, "/");
  const outsideReplacement =
    requestedPath && !isAbsolutePathLike(requestedPath)
      ? requestedPath
      : "<outside-workspace>";

  if (context.requestedPath && isAbsolutePathLike(context.requestedPath)) {
    sanitized = replaceAllLiteral(
      sanitized,
      context.requestedPath,
      outsideReplacement,
    );
  }

  // Error messages can include a resolved path that is outside the workspace,
  // so it cannot be reduced relative to the known roots. This runs only on
  // error/diagnostic text, never on successful file contents.
  sanitized = sanitized.replace(
    /[A-Za-z]:[\\/][^"\r\n,;)]*/g,
    outsideReplacement,
  );
  sanitized = sanitized.replace(
    /\/(?:home|Users|tmp|private|mnt|workspace|var|opt|srv)\/[^"\r\n,;)]*/g,
    outsideReplacement,
  );

  return sanitized;
}

const PATH_FIELD_PATTERN =
  /(?:^|_)(?:path|paths|root|roots|cwd|directory|directories)$/i;
const CAMEL_PATH_FIELD_PATTERN =
  /(?:Path|Paths|Root|Roots|Cwd|Directory|Directories)$/;
const MESSAGE_FIELD_PATTERN = /^(?:error|message|reason)$/i;

export function sanitizePublicPayload(
  value: any,
  context: PublicPathContext = {},
  fieldName?: string,
): any {
  if (typeof value === "string") {
    if (
      fieldName &&
      (PATH_FIELD_PATTERN.test(fieldName) ||
        CAMEL_PATH_FIELD_PATTERN.test(fieldName))
    ) {
      return sanitizePublicPath(value, context);
    }
    if (fieldName && MESSAGE_FIELD_PATTERN.test(fieldName)) {
      return sanitizePublicError(value, context);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" &&
      fieldName &&
      (PATH_FIELD_PATTERN.test(fieldName) ||
        CAMEL_PATH_FIELD_PATTERN.test(fieldName))
        ? sanitizePublicPath(item, context)
        : sanitizePublicPayload(item, context, fieldName),
    );
  }

  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizePublicPayload(item, context, key),
    ]),
  );
}

export function finalizeToolResponse(
  response: any,
  options: ToolResponseFinalizerOptions,
  instrumentation?: FinalizerInstrumentation,
): any {
  const {
    toolName,
    startedAt,
    inlineOutputCharacters,
    hasWidget,
    publicPathContext = {},
  } = options;

  const structured = response.structuredContent;
  const responseText = contentText(response.content ?? []);

  const existingEnvelope = isEnvelope(structured?.envelope)
    ? structured.envelope
    : isEnvelope(structured)
      ? structured
      : undefined;
  const legacyData = existingEnvelope ? undefined : legacyWrappedData(structured);

  let parsedFromText: any;
  let rawData: any;
  let fallbackText: string | undefined;
  let finalStatus = response.isError ? "error" : "success";

  if (existingEnvelope) {
    finalStatus = existingEnvelope.status;
    rawData = existingEnvelope.data;
  } else if (legacyData !== undefined) {
    rawData = legacyData;
  } else if (structured !== undefined) {
    rawData = structured;
  } else {
    if (instrumentation) instrumentation.increment("fallbackTextReads");

    fallbackText = responseText;
    parsedFromText = fallbackText;

    try {
      if (instrumentation) instrumentation.increment("jsonParses");
      parsedFromText = JSON.parse(fallbackText);
    } catch {
      // Plain text is a valid fallback.
    }

    if (isEnvelope(parsedFromText)) {
      finalStatus = parsedFromText.status;
      rawData = parsedFromText.data;
      parsedFromText = parsedFromText.error;
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
  const publicRawData = sanitizePublicPayload(rawData, publicPathContext);

  const basePolicy = {
    defaultStringLimit: inlineOutputCharacters,
    hardStringLimit: 64000,
  };

  let policy: any = { ...basePolicy };
  if (toolName === "git_diff" || toolName === "show_changes") {
    policy.fieldLimits = { diff: 32000, patch: 32000 };
  } else if (toolName === "apply_patch") {
    policy.fieldLimits = { preview: 32000 };
  }

  if (instrumentation) instrumentation.increment("truncationWalks");
  const { payload: data, metrics: truncMetrics } =
    truncatePayloadWithMetrics(publicRawData, policy);

  const wasTruncated =
    truncMetrics.totalTruncatedFields > 0 ||
    Boolean(
      response._meta?.truncated ||
        (fallbackText &&
          (fallbackText.includes("[truncated]") ||
            fallbackText.includes("... [truncated"))),
    );

  const rawEnvelopeError =
    existingEnvelope?.error ??
    (status === "error"
      ? commandFailure ??
        rawData?.error ??
        rawData?.message ??
        (typeof parsedFromText === "string"
          ? parsedFromText
          : parsedFromText?.error ?? parsedFromText?.message) ??
        responseText ??
        "Tool execution failed"
      : null);
  const envelopeError =
    status === "error"
      ? sanitizePublicError(String(rawEnvelopeError), publicPathContext)
      : null;

  const nativeDiagnostics =
    !existingEnvelope && Array.isArray(rawData?.diagnostics)
      ? rawData.diagnostics
      : [];
  const diagnostics = sanitizePublicPayload(
    existingEnvelope?.diagnostics ?? nativeDiagnostics,
    publicPathContext,
    "diagnostics",
  );

  const envelope = {
    status,
    data,
    error: envelopeError,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    metrics: {
      durationMs:
        existingEnvelope?.metrics?.durationMs ??
        Math.round(performance.now() - startedAt),
      truncated: wasTruncated,
      omittedCharacters: truncMetrics.omittedCharacters,
    },
  };

  const errorPreview =
    status === "error" && envelope.error
      ? (() => {
          const text = String(envelope.error).replace(/\s+/g, " ").trim();
          return text.length > 240 ? `${text.slice(0, 237)}...` : text;
        })()
      : undefined;
  const errorSuffix = errorPreview ? ` — ${errorPreview}` : "";
  const workspaceSuffix =
    toolName === "open_workspace" && data?.workspaceId
      ? ` — ${data.workspaceId}`
      : "";

  const { _meta: originalMeta, ...responseBody } = response;
  const publicMeta = sanitizePublicPayload(originalMeta, publicPathContext);
  const sanitizedMeta =
    !hasWidget && publicMeta?.card
      ? Object.fromEntries(
          Object.entries(publicMeta).filter(([key]) => key !== "card"),
        )
      : publicMeta;

  if (instrumentation) instrumentation.increment("jsonStringifies");
  const finalSummaryText = `${toolName}: ${status}${workspaceSuffix}${errorSuffix} (${JSON.stringify(envelope).length} chars, ${envelope.metrics.durationMs}ms)`;

  return {
    ...responseBody,
    ...(sanitizedMeta && Object.keys(sanitizedMeta).length > 0
      ? { _meta: sanitizedMeta }
      : {}),
    content: [{ type: "text" as const, text: finalSummaryText }],
    isError: status === "error",
    structuredContent: envelope,
  };
}
