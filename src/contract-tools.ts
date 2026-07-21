import { randomUUID } from "node:crypto";
import type { ToolResponse } from "./pi-tools.js";
import { recordPlan } from "./change-session.js";

// --- propose_plan ---
// When AGENTIC_STRICT_PVDL=true, this tool must be called before edit/write.
// Returns a planId so the user/agent can reference it later.

export interface ProposePlanInput {
  goal: string;
  filesToRead?: string[];
  filesToChange?: string[];
  riskAreas?: string[];
  verificationPlan?: string[];
}

export async function proposePlanTool(input: ProposePlanInput, workspaceId?: string): Promise<ToolResponse> {
  // Record the plan for PVDL enforcement (if workspaceId provided)
  let planId = "";
  if (workspaceId) {
    planId = recordPlan(workspaceId, input.goal, input.filesToChange);
  } else {
    planId = randomUUID().split("-")[0];
  }

  const response = {
    planId,
    summary: {
      goal: input.goal,
      filesToRead: input.filesToRead ?? [],
      filesToChange: input.filesToChange ?? [],
      riskAreas: input.riskAreas ?? [],
      verificationPlan: input.verificationPlan ?? [],
    },
    message:
      "Plan logged. Follow the plan when making edits. Call workspace_summary or file_dependencies first if needed. Use edit_dry_run before modifying files, and checkpoint_save to snapshot before risky changes.",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
  };
}
