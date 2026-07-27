import * as ts from "typescript";
import type { CodeRegion, CodeRegionKind } from "./types.js";

export interface ExtractCodeRegionsOptions {
  anchorKeywords?: string[];
  maxRegions?: number;
}

export function extractCodeRegions(
  filePath: string,
  content: string,
  options?: ExtractCodeRegionsOptions
): CodeRegion[] {
  // Ignorar arquivos não suportados ou genéricos d.ts
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(filePath) || filePath.endsWith(".d.ts")) {
    return [];
  }

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const sourceFile = ts.createSourceFile(filePath, normalizedContent, ts.ScriptTarget.Latest, true);

  const regions: Array<CodeRegion & { score: number, originalIndex: number }> = [];
  const anchorKeywords = (options?.anchorKeywords || []).map(k => k.toLowerCase());

  let index = 0;

  function hasExportModifier(node: ts.Node): boolean {
    return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  }

  function getDeclarationText(node: ts.Node): string {
    return node.getText(sourceFile);
  }

  function getSignatureAndBodyText(node: ts.Node): { signature: string, body: string } {
    const fullText = getDeclarationText(node);
    let bodyNode: ts.Node | undefined;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)) {
      bodyNode = node.body;
    } else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      bodyNode = node.initializer.body;
    }

    if (bodyNode) {
      const bodyStart = bodyNode.getStart(sourceFile) - node.getStart(sourceFile);
      return {
        signature: fullText.substring(0, bodyStart),
        body: fullText.substring(bodyStart)
      };
    }

    // Default se não houver corpo claro
    return { signature: fullText, body: "" };
  }

  function scoreRegion(
    name: string,
    qualifiedName: string | undefined,
    isExported: boolean,
    signature: string,
    body: string
  ): { score: number, matchedKeywords: string[] } {
    let score = 0;
    const matchedKeywords: string[] = [];

    const lowerName = name.toLowerCase();
    const lowerQualified = qualifiedName?.toLowerCase() || "";
    const lowerSignature = signature.toLowerCase();
    const lowerBody = body.toLowerCase();

    for (const kw of anchorKeywords) {
      let matched = false;
      if (lowerName === kw) {
        score += 100;
        matched = true;
      } else if (lowerName.includes(kw)) {
        score += 60;
        matched = true;
      } else if (lowerQualified.includes(kw)) {
        score += 50;
        matched = true;
      } else if (lowerSignature.includes(kw)) {
        score += 30;
        matched = true;
      } else if (lowerBody.includes(kw)) {
        score += 15;
        matched = true;
      }

      if (matched) {
        matchedKeywords.push(kw);
      }
    }

    if (isExported) {
      score += 5;
    }

    return { score, matchedKeywords };
  }

  function createRegion(node: ts.Node, name: string, kind: CodeRegionKind, parentName?: string, isExported = false) {
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const qualifiedName = parentName ? `${parentName}.${name}` : undefined;

    const { signature, body } = getSignatureAndBodyText(node);
    const { score, matchedKeywords } = scoreRegion(name, qualifiedName, isExported, signature, body);

    regions.push({
      name,
      qualifiedName,
      kind,
      startLine,
      endLine,
      matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : undefined,
      score,
      originalIndex: index++
    });
  }

  function visit(node: ts.Node, parentName?: string) {
    const isExported = hasExportModifier(node);

    if (ts.isFunctionDeclaration(node)) {
      createRegion(node, node.name ? node.name.text : "default", "function", parentName, isExported);
    } else if (ts.isClassDeclaration(node)) {
      const className = node.name ? node.name.text : "default";
      createRegion(node, className, "class", parentName, isExported);
      ts.forEachChild(node, child => visit(child, className));
    } else if (ts.isInterfaceDeclaration(node)) {
      createRegion(node, node.name.text, "interface", parentName, isExported);
    } else if (ts.isTypeAliasDeclaration(node)) {
      createRegion(node, node.name.text, "type", parentName, isExported);
    } else if (ts.isEnumDeclaration(node)) {
      createRegion(node, node.name.text, "enum", parentName, isExported);
    } else if (ts.isVariableStatement(node)) {
      // Exported variables ou variables que contem função/arrow function
      node.declarationList.declarations.forEach(d => {
        if (ts.isIdentifier(d.name)) {
          const isFunc = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
          if (isExported || isFunc) {
            createRegion(node, d.name.text, "variable", parentName, isExported);
          }
        }
      });
    } else if (ts.isMethodDeclaration(node) && node.name) {
      createRegion(node, node.name.getText(sourceFile), "method", parentName, isExported);
    } else if (ts.isGetAccessor(node) && node.name) {
      createRegion(node, node.name.getText(sourceFile), "method", parentName, isExported);
    } else if (ts.isSetAccessor(node) && node.name) {
      createRegion(node, node.name.getText(sourceFile), "method", parentName, isExported);
    } else if (ts.isConstructorDeclaration(node)) {
      createRegion(node, "constructor", "method", parentName, isExported);
    } else if (ts.isExportAssignment(node)) {
      if (ts.isFunctionDeclaration(node.expression)) {
        createRegion(node.expression, node.expression.name ? node.expression.name.text : "default", "function", parentName, true);
      } else if (ts.isClassDeclaration(node.expression)) {
        const exprName = node.expression.name ? node.expression.name.text : "default";
        createRegion(node.expression, exprName, "class", parentName, true);
        ts.forEachChild(node.expression, child => visit(child, exprName));
      } else {
        createRegion(node, "default", "variable", parentName, true);
      }
    } else if (ts.isSourceFile(node)) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);

  // Ordenar por score desc, originalIndex asc
  regions.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.originalIndex - b.originalIndex;
  });

  const max = options?.maxRegions ?? regions.length;
  
  return regions.slice(0, max).map(({ score, originalIndex, ...rest }) => rest);
}
