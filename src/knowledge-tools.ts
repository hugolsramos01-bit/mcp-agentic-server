import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import type { ToolResponse } from "./pi-tools.js";

const KNOWLEDGE_DIR = ".agentic";
const DECISIONS_DIR = "knowledge/decisions";
const MAX_KNOWLEDGE_FILES = 20;

function knowledgeBaseDir(cwd: string): string {
  return join(cwd, KNOWLEDGE_DIR, DECISIONS_DIR);
}

function ensureKnowledgeDir(cwd: string): string {
  const dir = knowledgeBaseDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

interface KnowledgeEntry {
  slug: string;
  timestamp: string;
  summary: string;
  supersedes?: string;
  scopedTo?: string[];
  content: string;
}

function parseKnowledgeFile(filePath: string): KnowledgeEntry | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // Parse YAML-like frontmatter
    let slug = "";
    let timestamp = "";
    let summary = "";
    let supersedes = "";
    let scopedTo: string[] = [];
    let inFrontmatter = false;
    let bodyStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (i === 0 && line === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && line === "---") {
        inFrontmatter = false;
        bodyStart = i + 1;
        continue;
      }
      if (inFrontmatter) {
        if (line.startsWith("slug:")) slug = line.slice(5).trim();
        else if (line.startsWith("timestamp:")) timestamp = line.slice(10).trim();
        else if (line.startsWith("summary:")) summary = line.slice(8).trim();
        else if (line.startsWith("supersedes:")) supersedes = line.slice(11).trim();
        else if (line.startsWith("scopedTo:")) {
          const arrMatch = line.match(/\[(.*?)\]/);
          if (arrMatch) scopedTo = arrMatch[1].split(",").map((s: string) => s.trim().replace(/['"]/g, "")).filter(Boolean);
        }
      }
    }

    const body = lines.slice(bodyStart).join("\n").trim();
    if (!slug) slug = filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") || "unknown";

    return { slug, timestamp, summary, supersedes, scopedTo, content: body };
  } catch {
    return null;
  }
}

export function readWorkspaceKnowledge(cwd: string, scopedTo?: string[]): KnowledgeEntry[] {
  const dir = knowledgeBaseDir(cwd);
  if (!existsSync(dir)) return [];

  const entries: KnowledgeEntry[] = [];
  const files = readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    if (!file.name.endsWith(".md")) continue;
    const entry = parseKnowledgeFile(join(dir, file.name));
    if (!entry) continue;

    // If scopedTo provided, filter by scope match
    if (scopedTo && scopedTo.length > 0 && entry.scopedTo && entry.scopedTo.length > 0) {
      const matches = entry.scopedTo.some((s) =>
        scopedTo.some((goal) => s.toLowerCase().includes(goal.toLowerCase()) || goal.toLowerCase().includes(s.toLowerCase()))
      );
      if (!matches) continue;
    }

    entries.push(entry);
    if (entries.length >= MAX_KNOWLEDGE_FILES) break;
  }

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// --- knowledge_capture ---

export interface KnowledgeCaptureInput {
  slug: string;
  summary: string;
  supersedes?: string;
  scopedTo?: string[];
  content: string;
}

export async function knowledgeCaptureTool(cwd: string, input: KnowledgeCaptureInput): Promise<ToolResponse> {
  const dir = ensureKnowledgeDir(cwd);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeSlug = input.slug.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
  const filePath = join(dir, `${timestamp}-${safeSlug}.md`);

  const scopeList = input.scopedTo?.length
    ? `scopedTo: [${input.scopedTo.map((s) => `"${s}"`).join(", ")}]`
    : "";
  const supersedesStr = input.supersedes ? `\nsupersedes: ${input.supersedes}` : "";

  const content = `---
slug: ${safeSlug}
timestamp: ${new Date().toISOString()}
summary: ${input.summary}${supersedesStr}
${scopeList}
---

${input.content}
`;

  writeFileSync(filePath, content, "utf8");

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            slug: safeSlug,
            timestamp: new Date().toISOString(),
            file: filePath,
            message: "Knowledge captured successfully.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// --- knowledge_search ---

export interface KnowledgeSearchInput {
  scopedTo?: string[];
}

export async function knowledgeSearchTool(cwd: string, input: KnowledgeSearchInput): Promise<ToolResponse> {
  const entries = readWorkspaceKnowledge(cwd, input.scopedTo);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            count: entries.length,
            entries: entries.map((e) => ({
              slug: e.slug,
              timestamp: e.timestamp,
              summary: e.summary,
              scopedTo: e.scopedTo,
              content: e.content.substring(0, 500),
            })),
          },
          null,
          2,
        ),
      },
    ],
  };
}

