import ts from "typescript";

export type CompressionLevel = "none" | "light" | "balanced" | "aggressive" | "skeletal";

export interface Omission {
  lines: string;
  reason: string;
}

export interface CompressionMetadata {
  level: CompressionLevel;
  originalTokensEstimate: number;
  outputTokensEstimate: number;
  compressionEffective: boolean;
  protectedBlocksPreserved: number;
  omittedBlocks: number;
  risk: "low" | "medium" | "high";
  mustExpandBeforeEdit: Omission[];
}

export interface CompressionResult {
  output: string;
  omissions: Omission[];
  metadata: CompressionMetadata;
}

const DEFAULT_PROTECT_POLICY = [
  // Security / Auth
  "password", "secret", "token", "cookie", "session", "auth", "tenant", "permission", "role", "admin", "csrf", "cors",
  // Payload CMS
  "access", "beforeChange", "afterChange", "beforeRead", "afterRead", "overrideAccess", "req.user", "collection", "slug", "hooks",
  // Next.js
  "middleware", "headers", "cookies", "redirect", "rewrite", "revalidatePath", "revalidateTag", "generateMetadata", "server-only", "use client", "use server",
  // Comments
  "SECURITY", "WARNING", "DO NOT", "IMPORTANT", "TODO auth", "FIXME auth", "tenant leak"
];

class AstCache {
  private cache = new Map<string, { mtime: number; sourceFile: ts.SourceFile }>();
  private readonly maxSize = 50;

  get(filePath: string, mtime: number): ts.SourceFile | undefined {
    const entry = this.cache.get(filePath);
    if (entry && entry.mtime === mtime) {
      // Move to end (most recently used)
      this.cache.delete(filePath);
      this.cache.set(filePath, entry);
      return entry.sourceFile;
    }
    return undefined;
  }

  set(filePath: string, mtime: number, sourceFile: ts.SourceFile) {
    if (this.cache.size >= this.maxSize) {
      // Map iteration returns keys in insertion order; delete the first one (oldest)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(filePath, { mtime, sourceFile });
  }
}

const globalAstCache = new AstCache();

/**
 * Perform AST-aware semantic compression on TypeScript/JavaScript code.
 */
export function compressAST(
  content: string, 
  level: CompressionLevel, 
  protectPatterns: string[] = DEFAULT_PROTECT_POLICY,
  filePath?: string,
  mtime?: number
): CompressionResult {
  
  if (level === "none") {
    // Normalize to LF for consistency with compressed output
    const lfContent = content.replace(/\r\n/g, '\n');
    return {
      output: lfContent,
      omissions: [],
      metadata: {
        level: "none",
        originalTokensEstimate: Math.ceil(lfContent.length / 4),
        outputTokensEstimate: Math.ceil(lfContent.length / 4),
        compressionEffective: false,
        protectedBlocksPreserved: 0,
        omittedBlocks: 0,
        risk: "low",
        mustExpandBeforeEdit: []
      }
    };
  }

  // Normalize CRLF -> LF to ensure TypeScript parser works correctly on Windows
  // This is critical: Windows line endings can cause the AST to produce wrong positions
  const normalizedContent = content.replace(/\r\n/g, '\n');

  let sourceFile: ts.SourceFile;
  if (filePath && mtime !== undefined) {
    const cached = globalAstCache.get(filePath, mtime);
    if (cached) {
      sourceFile = cached;
    } else {
      sourceFile = ts.createSourceFile(filePath, normalizedContent, ts.ScriptTarget.Latest, true);
      globalAstCache.set(filePath, mtime, sourceFile);
    }
  } else {
    sourceFile = ts.createSourceFile(filePath || "temp.ts", normalizedContent, ts.ScriptTarget.Latest, true);
  }

  // Skeletal is intentionally a declaration outline, not merely aggressive
  // compression. The previous implementation often returned almost the entire
  // file when functions were short or declarations were not object literals.
  if (level === "skeletal") {
    return buildSkeletalOutline(sourceFile, normalizedContent, filePath);
  }

  const omissionsToApply: { start: number; end: number; lines: string; reason: string; risk: "low" | "medium" | "high" }[] = [];
  let protectedBlocksPreserved = 0;

  function getLine(pos: number) {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  // A hybrid check: looks at AST node text, including trivia (comments)
  function hasProtectedPattern(node: ts.Node): boolean {
    if (protectPatterns.length === 0) return false;
    const text = node.getFullText(sourceFile); // gets text including leading comments
    return protectPatterns.some(p => text.includes(p));
  }

  function visit(node: ts.Node) {
    const isAggressive = level === "aggressive";
    const isBalanced = level === "balanced" || isAggressive;
    const isLight = level === "light" || isBalanced;

    if (isBalanced) {
      // Omit function/method/arrow bodies
      if (
        ts.isBlock(node) &&
        node.parent &&
        (ts.isFunctionDeclaration(node.parent) ||
          ts.isMethodDeclaration(node.parent) ||
          ts.isArrowFunction(node.parent) ||
          ts.isGetAccessor(node.parent) ||
          ts.isSetAccessor(node.parent))
      ) {
        if (!hasProtectedPattern(node)) {
          const startLine = getLine(node.getStart(sourceFile));
          const endLine = getLine(node.getEnd());
          const lineCount = endLine - startLine;
          
          if (lineCount > 3) {
            omissionsToApply.push({
              start: node.getStart(sourceFile),
              end: node.getEnd(),
              lines: `${startLine}-${endLine}`,
              reason: `function body omitted`,
              risk: "medium"
            });
            return; 
          }
        } else {
          protectedBlocksPreserved++;
        }
      }
    }

    if (isAggressive) {
      // Omit large variable declarations (arrays/objects)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (
          (ts.isArrayLiteralExpression(node.initializer) || ts.isObjectLiteralExpression(node.initializer))
        ) {
          if (!hasProtectedPattern(node.initializer)) {
            const startLine = getLine(node.initializer.getStart(sourceFile));
            const endLine = getLine(node.initializer.getEnd());
            const lineCount = endLine - startLine;
            
            if (lineCount > 5) {
              omissionsToApply.push({
                start: node.initializer.getStart(sourceFile),
                end: node.initializer.getEnd(),
                lines: `${startLine}-${endLine}`,
                reason: `large static object/array omitted`,
                risk: "low"
              });
              return;
            }
          } else {
            protectedBlocksPreserved++;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Sort descending by start position to safely replace from bottom up
  omissionsToApply.sort((a, b) => b.start - a.start);

  // CRITICAL: Use normalizedContent for replacement, NOT content.
  // The AST positions (start/end) are derived from normalizedContent
  // (CRLF→LF). If we applied them to content (which may have CRLF),
  // each CRLF line would shift positions by 1 byte per CR, causing
  // the replacement marker to eat into surrounding code — e.g.
  // "normalizeHost(input: string | nu { /* omitted */ }" instead of
  // "normalizeHost(input: string | null | undefined): string { ... }".
  let output = normalizedContent;
  const resultOmissions: Omission[] = [];
  const mustExpand: Omission[] = [];

  for (const om of omissionsToApply) {
    const before = output.substring(0, om.start);
    const after = output.substring(om.end);
    const lineCount = parseInt(om.lines.split("-")[1]) - parseInt(om.lines.split("-")[0]);
    
    let replacement = `{ /* [${lineCount} lines omitted: ${om.reason}] */ }`;
    
    // Prevent omission marker from concatenating with surrounding code.
    // E.g. "buildTenantPath{/*...*/}" is invalid — ensure whitespace before "{".
    // Only add space if `before` ends with a non-whitespace identifier character
    // that would merge with "{".
    if (before.length > 0 && /[a-zA-Z0-9_)]$/.test(before)) {
      replacement = " " + replacement;
    }
    
    output = before + replacement + after;
    
    resultOmissions.push({ lines: om.lines, reason: om.reason });
    if (om.risk === "medium" || om.risk === "high") {
      mustExpand.push({ lines: om.lines, reason: om.reason });
    }
  }

  const originalTokens = Math.ceil(content.length / 4);
  const outputTokens = Math.ceil(output.length / 4);
  const effectiveSavings = originalTokens - outputTokens;
  const compressionEffective = effectiveSavings > Math.max(50, originalTokens * 0.05);
  
  resultOmissions.reverse(); // top-down order
  mustExpand.reverse();

  return {
    output,
    omissions: resultOmissions,
    metadata: {
      level,
      originalTokensEstimate: originalTokens,
      outputTokensEstimate: outputTokens,
      compressionEffective,
      protectedBlocksPreserved,
      omittedBlocks: omissionsToApply.length,
      risk: level === "aggressive" ? "high" : (level === "balanced" ? "medium" : "low"),
      mustExpandBeforeEdit: mustExpand
    }
  };
}

function buildSkeletalOutline(sourceFile: ts.SourceFile, original: string, filePath?: string): CompressionResult {
  const lines: string[] = [`// Skeletal outline${filePath ? `: ${filePath}` : ""}`];
  const omissions: Omission[] = [];

  for (const statement of sourceFile.statements) {
    const startLine = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
    const text = statement.getText(sourceFile).trim();
    let outline: string;

    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      outline = trimDeclaration(text);
    } else if (ts.isFunctionDeclaration(statement)) {
      outline = `${text.slice(0, text.indexOf("{")).trim()} { /* body omitted */ }`;
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "AnonymousClass";
      const modifiers = statement.modifiers?.map((m) => m.getText(sourceFile)).join(" ") ?? "";
      const heritage = statement.heritageClauses?.map((clause) => clause.getText(sourceFile)).join(" ") ?? "";
      outline = `${modifiers} class ${name}${heritage ? ` ${heritage}` : ""} { /* members omitted */ }`.trim();
    } else if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.map((d) => d.name.getText(sourceFile)).join(", ");
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      outline = `${keyword} ${declaration} = /* initializer omitted */;`;
    } else {
      outline = `/* ${ts.SyntaxKind[statement.kind]} omitted */`;
    }

    lines.push(outline);
    if (endLine > startLine || outline !== text) {
      omissions.push({ lines: `${startLine}-${endLine}`, reason: "top-level implementation omitted" });
    }
  }

  const output = lines.join("\n") + "\n";
  const originalTokens = Math.ceil(original.length / 4);
  const outputTokens = Math.ceil(output.length / 4);
  return {
    output,
    omissions,
    metadata: {
      level: "skeletal",
      originalTokensEstimate: originalTokens,
      outputTokensEstimate: outputTokens,
      compressionEffective: originalTokens - outputTokens >= Math.max(50, originalTokens * 0.4),
      protectedBlocksPreserved: 0,
      omittedBlocks: omissions.length,
      risk: "high",
      mustExpandBeforeEdit: omissions,
    },
  };
}

function trimDeclaration(text: string): string {
  const maxLength = 500;
  return text.length > maxLength ? `${text.slice(0, maxLength)} /* declaration truncated */` : text;
}

/**
 * Expand a previously omitted block from a compressed file.
 * Takes the original file content and the omission description
 * (lines field from Omission) and returns the original block.
 */
export function expandOmittedBlock(content: string, blockDesc: string): { matched: boolean; block?: string; lines?: string } {
  // Parse "L100-L200" style descriptions
  const rangeMatch = blockDesc.match(/(\d+)\s*-\s*(\d+)/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]) - 1; // 1-indexed to 0-indexed
    const end = parseInt(rangeMatch[2]);
    const lines = content.split('\n');
    if (start >= 0 && end <= lines.length) {
      return {
        matched: true,
        block: lines.slice(start, end).join('\n'),
        lines: `L${start + 1}-L${end}`,
      };
    }
  }

  // Try matching by reason text
  const lowerBlock = blockDesc.toLowerCase();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerBlock)) {
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length, i + 15);
      return {
        matched: true,
        block: lines.slice(start, end).join('\n'),
        lines: `L${start + 1}-L${end}`,
      };
    }
  }

  return { matched: false };
}
