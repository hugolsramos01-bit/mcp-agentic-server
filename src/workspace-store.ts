// ═══════════════════════════════════════════════════════════════
// SESSION STORE — workspace session persistence
//
// SQLite-backed registry of workspace sessions with the Drizzle
// ORM. Supports create/get/touch lifecycle with automatic cleanup.
// ═══════════════════════════════════════════════════════════════

import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions, type WorkspaceSessionRow } from "./db/schema.js";

// ─── Public types ────────────────────────────────────────────

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(spec: WorkspaceSessionSpec): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  close?(): void;
}

export interface WorkspaceSessionSpec {
  id: string;
  root: string;
  mode?: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed?: boolean;
}

// ─── SQLite implementation ───────────────────────────────────

export class SqliteWorkspaceStore implements WorkspaceStore {
  #db: DatabaseHandle;

  constructor(stateDir: string) {
    this.#db = openDatabase(stateDir);
  }

  createSession(spec: WorkspaceSessionSpec): WorkspaceSession {
    const ts = new Date().toISOString();
    const record: WorkspaceSession = {
      id: spec.id,
      root: spec.root,
      status: "active",
      mode: spec.mode ?? "checkout",
      sourceRoot: spec.sourceRoot,
      baseRef: spec.baseRef,
      baseSha: spec.baseSha,
      managed: spec.managed ?? false,
      createdAt: ts,
      lastUsedAt: ts,
    };
    this.#db.db
      .insert(workspaceSessions)
      .values({
        id: record.id, root: record.root, status: record.status,
        mode: record.mode, sourceRoot: record.sourceRoot ?? null,
        baseRef: record.baseRef ?? null, baseSha: record.baseSha ?? null,
        managed: String(record.managed), createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })
      .run();
    return record;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.#db.db.select().from(workspaceSessions).where(eq(workspaceSessions.id, id)).get();
    return row ? mapRow(row) : undefined;
  }

  touchSession(id: string): void {
    this.#db.db.update(workspaceSessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(workspaceSessions.id, id)).run();
  }

  close(): void {
    this.#db.close();
  }
}

// ─── Factory ─────────────────────────────────────────────────

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

// ─── Row mapping ─────────────────────────────────────────────

function mapRow(r: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: r.id, root: r.root, status: r.status,
    mode: r.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: r.sourceRoot ?? undefined,
    baseRef: r.baseRef ?? undefined,
    baseSha: r.baseSha ?? undefined,
    managed: r.managed === "true",
    createdAt: r.createdAt, lastUsedAt: r.lastUsedAt,
  };
}
