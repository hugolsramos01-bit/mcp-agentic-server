const fs = require('fs');
let code = fs.readFileSync('src/server.ts', 'utf8');

const editTarget = `const editResultText = \`Edited \${input.path} (+\${stats.additions} -\${stats.removals}).\`;
      const editContent = [textBlock(editResultText)];`;

const editReplace = `const editResultText = \`Edited \${input.path} (+\${stats.additions} -\${stats.removals}).\`;
      const editReceipt = await formatMutationReceipt(workspace.root, [{ path: input.path, operation: "update", additions: stats.additions, removals: stats.removals }]);
      const editContent = [textBlock(editResultText + editReceipt)];`;

const writeTarget = `return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {`;

const writeReplace = `const writeReceipt = await formatMutationReceipt(workspace.root, [{ path: input.path, operation: "add", additions: summary.lines, removals: 0 }]);
      if (response.content && response.content.length > 0) {
        response.content[0].text += writeReceipt;
      }
      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {`;

code = code.replace(editTarget, editReplace);
code = code.replace(writeTarget, writeReplace);

fs.writeFileSync('src/server.ts', code);
