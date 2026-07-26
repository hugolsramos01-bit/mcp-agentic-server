import { TaskType } from "./types.js";

export interface NormalizedGoal {
  tokens: string[];
  expandedKeywords: string[];
  extractedPaths: string[];
  taskTypeSuggestion: TaskType;
  taskTypeSource: "explicit" | "inferred" | "default";
}

const STOPWORDS = new Set([
  // English
  "a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "with", "at", "by", "is",
  "as", "be", "it", "no", "not", "from", "this", "that", "but", "if", "so", "all", "can",
  "will", "would", "should", "could", "do", "does", "has", "have", "had", "was", "were",
  "are", "been", "about", "into", "up", "out", "just", "also", "very", "only", "its", "get",
  // Portuguese
  "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas",
  "no", "nos", "o", "os", "para", "por", "pela", "pelas", "pelo", "pelos", "que", "se",
  "sem", "sua", "suas", "seu", "seus", "um", "uma", "umas", "uns", "como", "entre",
  "entender", "avaliar", "melhorar", "usar", "criar", "ver", "ter", "fazer", "sobre",
]);

const SYNONYMS: Record<string, string[]> = {
  tenant: ["tenant", "tenancy", "org", "organization", "multi-tenant", "multitenant", "multi_tenant", "account", "workspace"],
  auth: ["auth", "authentication", "login", "signin", "oauth", "session", "jwt", "token", "password", "credential"],
  security: ["security", "secure", "safe", "protect", "permission", "acl", "rbac", "access-control", "safety", "vulnerability"],
  middleware: ["middleware", "interceptor", "filter", "hook", "pipe", "chain"],
  permission: ["permission", "role", "access", "allow", "deny", "policy", "capability", "scope", "privilege"],
  isolation: ["isolation", "isolated", "separate", "sandbox", "compartment", "boundary", "partition", "scope", "scoped"],
  api: ["api", "endpoint", "route", "rest", "graphql", "rpc", "handler", "controller"],
  database: ["database", "db", "sql", "query", "collection", "model", "schema", "store", "repository"],
  builder: ["builder", "build", "construct", "factory", "generator", "creator", "page-builder", "pagebuilder", "editor"],
  public: ["public", "client", "frontend", "customer", "user-facing", "external", "open", "unauthenticated", "anonymous"],
};

function normalizeToken(t: string): string { 
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); 
}

function inferTaskType(goal: string): TaskType | null {
  const normalized = normalizeToken(goal);
  if (/\b(bug|fix|corrigir|error|crash|issue)\b/i.test(normalized)) return "bug_fix";
  if (/\b(feat|feature|adicionar|add|create|novo)\b/i.test(normalized)) return "feature";
  if (/\b(refactor|refatorar|clean|cleanup)\b/i.test(normalized)) return "refactor";
  if (/\b(security|vulnerability|auth|secure)\b/i.test(normalized)) return "security_review";
  if (/\b(migrate|migration|migrar|update)\b/i.test(normalized)) return "migration";
  if (/\b(ui|frontend|css|react|vue|component)\b/i.test(normalized)) return "frontend";
  if (/\b(release|publish|deploy)\b/i.test(normalized)) return "release";
  return null;
}

export function normalizeGoal(goal: string, explicitType?: TaskType): NormalizedGoal {
  const lowerGoal = goal.toLowerCase();
  
  // Extract explicit file paths (things with / or .ts, .js, etc. without whitespace inside)
  const extractedPaths = Array.from(goal.matchAll(/(?:[a-zA-Z0-9_-]+[\\/])+[a-zA-Z0-9_.-]+|[a-zA-Z0-9_-]+\.(?:ts|js|tsx|jsx|json|md|py|go|rs|cpp|h|css|html)\b/g))
    .map(m => m[0].replace(/\\/g, "/"))
    .filter(p => !p.startsWith("http://") && !p.startsWith("https://"));

  const rawTokens = lowerGoal.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.filter(t => !STOPWORDS.has(normalizeToken(t)) && t.length > 1);
  
  const expandedKeywords = new Set(tokens);
  for (const token of tokens) {
    const nt = normalizeToken(token);
    for (const [key, syns] of Object.entries(SYNONYMS)) {
      if (nt.includes(key) || key.includes(nt) || syns.some(s => s.includes(nt) || nt.includes(s))) {
        for (const s of syns) expandedKeywords.add(s);
      }
    }
  }
  
  const keywords = [...expandedKeywords].filter(k => k.length > 2);
  
  let finalTaskType: TaskType = "auto";
  let taskTypeSource: "explicit" | "inferred" | "default" = "default";
  
  if (explicitType && explicitType !== "auto") {
    finalTaskType = explicitType;
    taskTypeSource = "explicit";
  } else {
    const inferred = inferTaskType(goal);
    if (inferred) {
      finalTaskType = inferred;
      taskTypeSource = "inferred";
    }
  }

  return {
    tokens,
    expandedKeywords: keywords,
    extractedPaths: [...new Set(extractedPaths)],
    taskTypeSuggestion: finalTaskType,
    taskTypeSource,
  };
}
