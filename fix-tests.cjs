const fs = require('fs');
let c = fs.readFileSync('src/change-intelligence/task-context.test.ts', 'utf8');

c = c.replace(/await mkdir\(join\(root, "\.git"\), \{ recursive: true \}\);/g, 'await execFileAsync("git", ["init"], { cwd: root });');

c = c.replace(/import \{ tmpdir \} from "node:os";/g, `import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
async function gitAddAll(cwd) { await execFileAsync("git", ["add", "."], { cwd }); }`);

c = c.replace(/const res = await buildTaskContext/g, 'await gitAddAll(root);\n    const res = await buildTaskContext');

c = c.replace(/goal: "fix payment logic in src\/payment\.ts",/g, 'goal: "fix payment logic in src/payment.ts",\n      depth: "balanced",');

fs.writeFileSync('src/change-intelligence/task-context.test.ts', c);
