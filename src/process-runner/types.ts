export type ExecutionStatus =
  | "success"
  | "command_failed"
  | "infrastructure_error"
  | "policy_blocked"
  | "dependencies_missing"
  | "timeout"
  | "invalid_configuration"
  | "script_not_found";

export type ProcessResult =
  | {
      status: "success";
      executable: string;
      args: string[];
      cwd: string;
      exitCode: 0;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "command_failed";
      executable: string;
      args: string[];
      cwd: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "infrastructure_error";
      executable: string;
      args: string[];
      cwd: string;
      code?: string;
      message: string;
      cause?: string;
      durationMs: number;
    }
  | {
      status: "timeout";
      executable: string;
      args: string[];
      cwd: string;
      timeoutMs: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "policy_blocked" | "dependencies_missing" | "invalid_configuration" | "script_not_found";
      executable: string;
      args: string[];
      cwd: string;
      message: string;
      durationMs: number;
    };

export interface ProcessRunnerOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
