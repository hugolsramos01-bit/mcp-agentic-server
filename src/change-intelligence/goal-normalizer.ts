import { TaskType } from "./types.js";

export interface NormalizedGoal {
  tokens: string[];
  expandedKeywords: string[];
  /** Subset of expandedKeywords excluding ACTION_WORDS — suitable for content grep. */
  anchorKeywords: string[];
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

/** Operational verbs and action words — excluded from content grep to reduce noise. */
const ACTION_WORDS = new Set([
  // English
  "add", "added", "adding", "fix", "fixed", "fixing", "create", "created", "creating",
  "implement", "implemented", "implementing", "remove", "removed", "removing",
  "update", "updated", "updating", "change", "changed", "changing", "improve",
  "improved", "improving", "refactor", "refactored", "refactoring", "migrate",
  "migrated", "migrating", "delete", "deleted", "deleting", "support", "supported",
  "supporting", "handle", "handled", "handling", "manage", "managed", "managing",
  "allow", "allowed", "allowing", "enable", "enabled", "enabling", "disable",
  "disabled", "disabling", "prevent", "prevented", "preventing", "ensure", "ensured",
  "ensuring", "make", "made", "making", "use", "used", "using", "set", "setting",
  "get", "getting", "run", "running", "ran", "test", "tested", "testing", "check",
  "checked", "checking", "validate", "validated", "validating", "verify", "verified",
  "verifying", "show", "showed", "showing", "display", "displayed", "displaying",
  "render", "rendered", "rendering", "build", "built", "building", "deploy",
  "deployed", "deploying", "release", "released", "releasing", "publish", "published",
  "publishing", "start", "started", "starting", "stop", "stopped", "stopping",
  "configure", "configured", "configuring", "setup", "install", "installed",
  "installing", "export", "exported", "exporting", "import", "imported", "importing",
  "require", "required", "requiring", "include", "included", "including", "extend",
  "extended", "extending", "override", "overrode", "overriding", "wrap", "wrapped",
  "wrapping", "convert", "converted", "converting", "transform", "transformed",
  "transforming", "merge", "merged", "merging", "split", "splitting", "join",
  "joined", "joining", "combine", "combined", "combining", "separate", "separated",
  "separating", "extract", "extracted", "extracting", "inject", "injected",
  "injecting", "process", "processed", "processing", "parse", "parsed", "parsing",
  "generate", "generated", "generating", "produce", "produced", "producing",
  "consume", "consumed", "consuming", "fetch", "fetched", "fetching", "send",
  "sent", "sending", "receive", "received", "receiving", "return", "returned",
  "returning", "pass", "passed", "passing", "throw", "threw", "throwing", "catch",
  "caught", "catching", "log", "logged", "logging", "debug", "debugged", "debugging",
  "monitor", "monitored", "monitoring", "track", "tracked", "tracking", "watch",
  "watched", "watching", "listen", "listened", "listening", "connect", "connected",
  "connecting", "disconnect", "disconnected", "disconnecting", "register",
  "registered", "registering", "unregister", "unregistered", "subscribe",
  "subscribed", "subscribing", "unsubscribe", "unsubscribed", "open", "opened",
  "opening", "close", "closed", "closing", "begin", "began", "beginning", "end",
  "ended", "ending", "finish", "finished", "finishing", "complete", "completed",
  "completing", "cancel", "canceled", "canceling", "reject", "rejected", "rejecting",
  "accept", "accepted", "accepting", "approve", "approved", "approving", "deny",
  "denied", "denying", "grant", "granted", "granting", "revoke", "revoked",
  "revoking", "look", "looking", "find", "finding", "found", "search", "searched",
  "searching", "replace", "replaced", "replacing", "rename", "renamed", "renaming",
  "move", "moved", "moving", "copy", "copied", "copying", "paste", "pasted",
  "pasting", "write", "wrote", "writing", "read", "reading", "load", "loaded",
  "loading", "save", "saved", "saving", "reset", "resetting", "retry", "retried",
  "retrying", "skip", "skipped", "skipping", "sort", "sorted", "sorting",
  "filter", "filtered", "filtering", "map", "mapped", "mapping", "reduce",
  "reduced", "reducing", "aggregate", "aggregated", "aggregating", "collect",
  "collected", "collecting", "accumulate", "accumulated", "accumulating",
  // Portuguese
  "adicionar", "adicionado", "corrigir", "corrigido", "criar", "criado",
  "implementar", "implementado", "remover", "removido", "atualizar", "atualizado",
  "alterar", "alterado", "melhorar", "melhorado", "refatorar", "refatorado",
  "migrar", "migrado", "deletar", "deletado", "suportar", "suportado",
  "gerenciar", "gerenciado", "permitir", "permitido", "habilitar", "habilitado",
  "desabilitar", "desabilitado", "prevenir", "prevenido", "garantir", "garantido",
  "configurar", "configurado", "instalar", "instalado", "exportar", "exportado",
  "importar", "importado", "gerar", "gerado", "processar", "processado",
  "validar", "validado", "verificar", "verificado", "mostrar", "mostrado",
  "exibir", "exibido", "renderizar", "renderizado", "construir", "construido",
  "publicar", "publicado", "comecar", "comecado", "iniciar", "iniciado",
  "finalizar", "finalizado", "completar", "completado", "cancelar", "cancelado",
  "rejeitar", "rejeitado", "aceitar", "aceitado", "aprovar", "aprovado",
  "negar", "negado", "conceder", "concedido", "revogar", "revogado",
  "procurar", "procurado", "buscar", "buscado", "substituir", "substituido",
  "renomear", "renomeado", "mover", "movido", "copiar", "copiado",
  "escrever", "escrito", "carregar", "carregado", "salvar", "salvado",
  "reiniciar", "reiniciado", "pular", "pulado", "filtrar", "filtrado",
  "mapear", "mapeado", "reduzir", "reduzido", "coletar", "coletado",
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
  
  // anchorKeywords = expandedKeywords minus ACTION_WORDS (noun/adjective terms suitable for grep)
  const anchorKeywords = keywords.filter(k => !ACTION_WORDS.has(k));
  
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
    anchorKeywords,
    extractedPaths: [...new Set(extractedPaths)],
    taskTypeSuggestion: finalTaskType,
    taskTypeSource,
  };
}
