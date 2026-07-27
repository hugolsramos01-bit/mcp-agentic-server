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
  alias?: string;
  normalizedAlias?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(spec: WorkspaceSessionSpec): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  getSessionByAlias(normalizedAlias: string): WorkspaceSession | undefined;
  listSessions(): WorkspaceSession[];
  deleteSession(id: string): boolean;
  updateAlias(id: string, alias: string | null, normalizedAlias: string | null): boolean;
  updateStatus(id: string, status: string): boolean;
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
  alias?: string;
  normalizedAlias?: string;
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
      alias: spec.alias,
      normalizedAlias: spec.normalizedAlias,
      createdAt: ts,
      lastUsedAt: ts,
    };
    this.#db.db
      .insert(workspaceSessions)
      .values({
        id: record.id, root: record.root, status: record.status,
        mode: record.mode, sourceRoot: record.sourceRoot ?? null,
        baseRef: record.baseRef ?? null, baseSha: record.baseSha ?? null,
        managed: String(record.managed), 
        alias: record.alias ?? null,
        normalizedAlias: record.normalizedAlias ?? null,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })
      .run();
    return record;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.#db.db.select().from(workspaceSessions).where(eq(workspaceSessions.id, id)).get();
    return row ? mapRow(row) : undefined;
  }

  getSessionByAlias(normalizedAlias: string): WorkspaceSession | undefined {
    const row = this.#db.db.select().from(workspaceSessions).where(eq(workspaceSessions.normalizedAlias, normalizedAlias)).get();
    return row ? mapRow(row) : undefined;
  }

  listSessions(): WorkspaceSession[] {
    const rows = this.#db.db.select().from(workspaceSessions).orderBy(workspaceSessions.lastUsedAt).all();
    return rows.map(mapRow).reverse();
  }

  deleteSession(id: string): boolean {
    this.#pendingTouches.delete(id);
    const result = this.#db.db.delete(workspaceSessions).where(eq(workspaceSessions.id, id)).run();
    return result.changes > 0;
  }

  updateAlias(id: string, alias: string | null, normalizedAlias: string | null): boolean {
    this.#pendingTouches.delete(id);
    const result = this.#db.db.update(workspaceSessions)
      .set({ alias, normalizedAlias, lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
    return result.changes > 0;
  }

  updateStatus(id: string, status: string): boolean {
    this.#pendingTouches.delete(id);
    const result = this.#db.db.update(workspaceSessions)
      .set({ status, lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
    return result.changes > 0;
  }

  #pendingTouches = new Map<string, string>();
  #touchTimer?: NodeJS.Timeout;

  touchSession(id: string): void {
    this.#pendingTouches.set(id, new Date().toISOString());
    if (!this.#touchTimer) {
      this.#touchTimer = setTimeout(() => this.#flushTouches(), 5000);
      this.#touchTimer.unref();
    }
  }

  #flushTouches(): void {
    if (this.#pendingTouches.size === 0) return;
    const pending = new Map(this.#pendingTouches);
    this.#pendingTouches.clear();
    this.#touchTimer = undefined;

    try {
      this.#db.db.transaction((tx) => {
        for (const [id, lastUsedAt] of pending) {
          tx.update(workspaceSessions)
            .set({ lastUsedAt })
            .where(eq(workspaceSessions.id, id))
            .run();
        }
      });
    } catch (err) {
      // Ignore background flush errors
    }
  }

  close(): void {
    if (this.#touchTimer) {
      clearTimeout(this.#touchTimer);
      this.#touchTimer = undefined;
    }
    this.#flushTouches();
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
    alias: r.alias ?? undefined,
    normalizedAlias: r.normalizedAlias ?? undefined,
    createdAt: r.createdAt, lastUsedAt: r.lastUsedAt,
  };
}
