// ═══════════════════════════════════════════════════════════════
// OBSERVABILITY — structured logging and request tracing
//
// Lightweight event emitter for the Agentic MCP server.
// Supports JSON and pretty-print output, IP resolution through
// proxy headers, and command preview truncation.
// ═══════════════════════════════════════════════════════════════

import type { Request } from "express";

// ─── Types ───────────────────────────────────────────────────

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type FieldBag = Record<string, unknown>;

// ─── Level gating ────────────────────────────────────────────

const SEVERITY: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function shouldLog(cfg: LoggingConfig, lvl: Exclude<LogLevel, "silent">): boolean {
  return SEVERITY[cfg.level] >= SEVERITY[lvl];
}

// ─── Event emission ──────────────────────────────────────────

export function logEvent(cfg: LoggingConfig, lvl: Exclude<LogLevel, "silent">, evt: string, fields: FieldBag = {}): void {
  if (!shouldLog(cfg, lvl)) return;
  const payload = { ts: new Date().toISOString(), level: lvl, event: evt, ...fields };
  const text = cfg.format === "pretty" ? renderPretty(payload) : JSON.stringify(payload);
  const sink = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
  sink(text);
}

function renderPretty(entry: FieldBag): string {
  const head = String(entry.level).toUpperCase();
  const extra = Object.entries(entry)
    .filter(([k]) => k !== "ts" && k !== "level" && k !== "event")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `${entry.ts} ${head} ${entry.event}${extra ? " " + extra : ""}`;
}

// ─── Request utilities ───────────────────────────────────────

/** Return the best-effort client IP, optionally inspecting proxy headers. */
export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (!trustProxy) return req.ip ?? req.socket.remoteAddress;
  return (
    extractFirst(req.header("cf-connecting-ip")) ??
    extractFirst(req.header("x-forwarded-for")) ??
    req.ip ??
    req.socket.remoteAddress
  );
}

function extractFirst(raw: string | undefined): string | undefined {
  return raw?.split(",")[0]?.trim() || undefined;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sid: string | undefined): string | undefined {
  return sid?.slice(0, 8);
}

/** Truncate long shell commands to a human-readable preview. */
export function commandPreview(cmd: string): string {
  const flat = cmd.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 117) + "..." : flat;
}
