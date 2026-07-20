import assert from "node:assert/strict";
import { compressLog } from "./log-compressor.js";

const successful = compressLog(
  "npm run test",
  "stderr: Error: expected failure exercised by this test\nTests  90 passed\n",
  0,
);
assert.equal(successful.status, "success");
assert.equal(successful.summary.errors, 0);
assert.equal(successful.summary.primaryError, undefined);
assert.deepEqual(successful.suggestedReads, []);

const failed = compressLog("npm run typecheck", "src/app.ts:4:2 error TS2322: Type mismatch", 1);
assert.equal(failed.status, "failed");
assert.equal(failed.summary.errors > 0, true);
assert.equal(failed.summary.primaryError?.code, "TS2322");
