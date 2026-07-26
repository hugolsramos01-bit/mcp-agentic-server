const fs = require('fs');
let code = fs.readFileSync('src/server.ts', 'utf8');

// We need to import `generateMutationReceipt` instead of `formatMutationReceipt`
code = code.replace('import { formatMutationReceipt } from "./server/mutation-receipt.js";', 'import { generateMutationReceipt } from "./server/mutation-receipt.js";\nimport { stat } from "node:fs/promises";\nimport { join } from "node:path";');

// 1. apply_patch
const applyPatchTarget = `const receipt = await formatMutationReceipt(workspace.root, result.files);
          const content = [textBlock(summary + receipt)];
          
          return {
            content,
            _meta: { 
              tool: "apply_patch", 
              card: { 
                workspaceId: req.workspaceId, 
                summary, 
                payload: { 
                  files: result.files, 
                  preview: result.patch 
                } 
              } 
            },
            structuredContent: {
              status: "applied",
              result: summary,
              files: result.files
            }
          };`;
const applyPatchReplace = `const receipt = await generateMutationReceipt(workspace.root, result.files);
          const content = [textBlock(summary)];
          
          return {
            content,
            _meta: { 
              tool: "apply_patch", 
              card: { 
                workspaceId: req.workspaceId, 
                summary, 
                payload: { 
                  files: result.files, 
                  preview: result.patch 
                } 
              } 
            },
            structuredContent: {
              status: "applied",
              result: summary,
              files: result.files,
              mutationReceipt: receipt
            }
          };`;
code = code.replace(applyPatchTarget, applyPatchReplace);

// 2. write
// Need to find exactly where `writeFileTool` is handled.
const writeStart = code.indexOf('toolNames.write,');
const writeEnd = code.indexOf('structuredContent: {', writeStart);
if (writeStart !== -1 && writeEnd !== -1) {
  // We want to insert the receipt generation before the `return` block.
  const writeReturnBlockStart = code.indexOf('return {', writeEnd - 100);
  
  // We also need to check if file existed before. Let's insert a check at the top of the async function for write.
  const writeFuncStart = code.indexOf('async ({ workspaceId, ...input }) => {', writeStart);
  if (writeFuncStart !== -1) {
    const afterFuncStart = writeFuncStart + 'async ({ workspaceId, ...input }) => {'.length;
    code = code.slice(0, afterFuncStart) + `\n      let existedBefore = false;\n      try { await stat(join(workspace.root, input.path)); existedBefore = true; } catch {}\n` + code.slice(afterFuncStart);
  }

  // Now replace the return block
  const oldWriteReturn = `return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };`;
  
  const newWriteReturn = `const receipt = await generateMutationReceipt(workspace.root, [{
        path: input.path,
        operation: existedBefore ? "update" : "add",
        additions: summary.lines,
        removals: 0
      }]);
      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
          mutationReceipt: receipt
        },
      };`;
  code = code.replace(oldWriteReturn, newWriteReturn);
}

// 3. edit
const editStart = code.indexOf('toolNames.edit,');
if (editStart !== -1) {
  const oldEditReturn = `return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch: stats.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: editResultText,
        },
      };`;
  
  const newEditReturn = `const receipt = await generateMutationReceipt(workspace.root, [{
        path: input.path,
        operation: "update",
        additions: stats.additions,
        removals: stats.removals
      }]);
      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch: stats.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: editResultText,
          mutationReceipt: receipt
        },
      };`;
  code = code.replace(oldEditReturn, newEditReturn);
}

fs.writeFileSync('src/server.ts', code);
