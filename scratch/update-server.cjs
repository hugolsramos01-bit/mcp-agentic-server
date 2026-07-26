const fs = require('fs');
let code = fs.readFileSync('src/server.ts', 'utf8');

const writeTarget = 'return wrap(toolNames.write, req, response);';
const writeReplace = `if (!response.isError) {
          const receipt = await formatMutationReceipt(workspace.root, [{ path: input.path, operation: "update" }]);
          response.content.push({ type: "text", text: receipt });
        }
        return wrap(toolNames.write, req, response);`;

const editTarget = 'return wrap(toolNames.edit, req, response);';
const editReplace = `if (!response.isError) {
          const receipt = await formatMutationReceipt(workspace.root, [{ path: input.path, operation: "update" }]);
          response.content.push({ type: "text", text: receipt });
        }
        return wrap(toolNames.edit, req, response);`;

code = code.replace(writeTarget, writeReplace);
code = code.replace(editTarget, editReplace);
fs.writeFileSync('src/server.ts', code);
