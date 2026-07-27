const fs = require('fs');
const code = fs.readFileSync('src/server.ts', 'utf8');
const matches = [...code.matchAll(/registerAppTool\(\s*server,\s*['"]([^'"]+)['"]/g)];
console.log(matches.map(m => m[1]).join(', '));
