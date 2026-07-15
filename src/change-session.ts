// ─── ChangeSession ───────────────────────────────────────────
// A per-workspace session that tracks the full PVDL flow:
// Plan → Verify → Do → Log.
//
// Unlike the old pvdl.ts (which only tracked booleans), this
// stores the actual plan, checkpoint IDs, edited files, and
// dry-run results — forming a shared context between tools.

export interface ChangePlan {
  planId: string;
  goal: string;
  filesToRead?: string[];
  filesToChange?: string[];
  riskAreas?: string[];
  verificationPlan?: string[];
  createdAt: number;
}

export interface DryRunRecord {
  path: string;
  edits: any;
  timestamp: number;
}

export interface ChangeRecord {
  path: string;
  tool: "edit" | "write" | "apply_patch";
  timestamp: number;
  summary?: string;
}

export interface CheckpointRecord {
  id: string;
  description?: string;
  timestamp: number;
}

export interface ChangeSession {
  plan?: ChangePlan;
  checkpoints: CheckpointRecord[];
  dryRuns: DryRunRecord[];
  appliedChanges: ChangeRecord[];
  shownChanges: boolean;
}

const sessions = new Map<string, ChangeSession>();

function getSession(workspaceId: string): ChangeSession {
  if (!sessions.has(workspaceId)) {
    sessions.set(workspaceId, {
      checkpoints: [],
      dryRuns: [],
      appliedChanges: [],
      shownChanges: false,
    });
  }
  return sessions.get(workspaceId)!;
}

// ─── Plan ────────────────────────────────────────────────────

export function recordPlan(workspaceId: string, goal: string, filesToChange?: string[]): string {
  const s = getSession(workspaceId);
  const planId = (Date.now() % 100000).toString(36) + Math.random().toString(36).slice(2, 6);
  s.plan = {
    planId,
    goal,
    filesToChange,
    createdAt: Date.now(),
  };
  return planId;
}

export function getPlan(workspaceId: string): ChangePlan | undefined {
  return getSession(workspaceId).plan;
}

// ─── Dry Run ─────────────────────────────────────────────────

export function recordDryRun(workspaceId: string, path: string, edits: any): void {
  const s = getSession(workspaceId);
  s.dryRuns.push({ path, edits, timestamp: Date.now() });
}

// ─── Checkpoint ──────────────────────────────────────────────

export function recordCheckpoint(workspaceId: string, id: string, description?: string): void {
  const s = getSession(workspaceId);
  s.checkpoints.push({ id, description, timestamp: Date.now() });
}

// ─── Edit ────────────────────────────────────────────────────

export function recordChange(workspaceId: string, path: string, tool: "edit" | "write" | "apply_patch", summary?: string): void {
  const s = getSession(workspaceId);
  s.appliedChanges.push({ path, tool, timestamp: Date.now(), summary });
}

export function getChangedFiles(workspaceId: string): string[] {
  const s = getSession(workspaceId);
  return [...new Set(s.appliedChanges.map(c => c.path))];
}

// ─── Show Changes ────────────────────────────────────────────

export function markChangesShown(workspaceId: string): void {
  getSession(workspaceId).shownChanges = true;
}

export function hasUnshownChanges(workspaceId: string): boolean {
  const s = getSession(workspaceId);
  return s.appliedChanges.length > 0 && !s.shownChanges;
}

// ─── Summary ─────────────────────────────────────────────────

export function getChangeSummary(workspaceId: string): any {
  const s = getSession(workspaceId);
  return {
    hasPlan: !!s.plan,
    planGoal: s.plan?.goal,
    planFilesToChange: s.plan?.filesToChange,
    dryRunCount: s.dryRuns.length,
    checkpointCount: s.checkpoints.length,
    changesCount: s.appliedChanges.length,
    changedFiles: getChangedFiles(workspaceId),
    shownChanges: s.shownChanges,
  };
}

// ─── PVDL Enforcement ───────────────────────────────────────

export function checkEditAllowed(workspaceId: string, path: string, strict: boolean): {
  allowed: boolean; reason?: string; warn?: string; confidence?: "low" | "medium" | "high";
} {
  if (!strict) return { allowed: true, confidence: "high" };

  const s = getSession(workspaceId);

  if (!s.plan) {
    return {
      allowed: false,
      reason: "PVDL flow requires propose_plan before edits. Call propose_plan first with your goal, files to change, and verification plan.",
    };
  }

  const hasDryRunForPath = s.dryRuns.some(d => d.path === path);
  if (!hasDryRunForPath) {
    return {
      allowed: true,
      confidence: "low",
      warn: `PVDL: edit_dry_run was not called for '${path}'. Skipping dry-run increases risk of bad replacements. Call edit_dry_run first to preview the change.`,
    };
  }

  const hasCheckpoint = s.checkpoints.length > 0;
  if (!hasCheckpoint) {
    return {
      allowed: true,
      warn: "PVDL: No checkpoint saved before this edit. Consider calling checkpoint_save first to snapshot the current state.",
    };
  }

  return { allowed: true, confidence: "high" };
}

export function resetSession(workspaceId: string): void {
  sessions.delete(workspaceId);
}

// ─── Session Garbage Collection ──────────────────────────────
// Clear sessions for workspaces that are no longer active.
// Call periodically or on workspace close.

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

export function gcSessions(activeWorkspaceIds: Set<string>): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (activeWorkspaceIds.has(id)) continue;
    const lastActivity = Math.max(
      session.plan?.createdAt ?? 0,
      ...session.dryRuns.map(d => d.timestamp),
      ...session.checkpoints.map(c => c.timestamp),
      ...session.appliedChanges.map(c => c.timestamp),
    );
    if (now - lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}
