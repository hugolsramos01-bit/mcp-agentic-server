const fs = require('fs');
let c = fs.readFileSync('src/change-intelligence/task-context.test.ts', 'utf8');
c = c.replace(/buildTaskContext\(\{/g, 'buildTaskContext({ workspaceId: "test",');
fs.writeFileSync('src/change-intelligence/task-context.test.ts', c);
