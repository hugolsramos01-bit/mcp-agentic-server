import assert from "node:assert/strict";
import { resolveShellCommand } from "./process-sessions.js";
import { terminateProcessTree } from "./process-sessions.js";

// resolveShellCommand tests — cross-platform shell detection
assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

// terminateProcessTree — run on the real platform to verify no-throw
const mockProc = { pid: 99999, kill: () => true as boolean };
try {
  terminateProcessTree(mockProc, "SIGTERM", false);
} catch (e: any) {
  // ESRCH is expected — PID 99999 doesn't exist
  if (e.code !== "ESRCH") throw e;
}
