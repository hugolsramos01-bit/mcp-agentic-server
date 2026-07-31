import { TaskType } from "./types.js";

export type GoalKeywordOrigin = "explicit" | "expanded";
export type GoalKeywordStrength = "weak" | "normal" | "strong";

export interface GoalKeywordSignal {
  value: string;
  origin: GoalKeywordOrigin;
  strength: GoalKeywordStrength;
  canonical?: string;
}

export interface NormalizedGoal {
  tokens: string[];
  expandedKeywords: string[];
  /** Subset of expandedKeywords excluding ACTION_WORDS — suitable for content grep. */
  anchorKeywords: string[];
  /** Ranked internal keyword metadata. Not exposed in TaskContextResult. */
  keywordSignals: GoalKeywordSignal[];
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
  "identificar", "localizar", "logica", "tratamento", "mensagem", "mensagens",
  "erro", "erros", "duplicada", "duplicadas",
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
  "migrar", "migrado", "deletar", "deletado", "suporte", "suportar", "suportado",
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
  // Generic issue/feature nouns (not domain anchors)
  "bug", "bugs", "feature", "features", "issue", "issues", "tarefa", "task",
]);

interface SynonymGroup {
  canonical: string;
  aliases: string[];
}

const SYNONYM_GROUPS: SynonymGroup[] = [
  { canonical: "tenant", aliases: ["tenant", "tenancy", "org", "organization", "multi-tenant", "multitenant", "multi_tenant", "account", "workspace"] },
  { canonical: "auth", aliases: ["auth", "authentication", "autenticacao", "autenticar", "login", "signin", "oauth", "session", "sessions", "sessao", "sessoes", "jwt", "token", "tokens", "password", "passwords", "senha", "senhas", "credential", "credentials", "credencial", "credenciais"] },
  { canonical: "expiration", aliases: ["expiration", "expirations", "expiracao", "expiracoes", "expire", "expires", "expired", "expirado", "expirada", "expira", "expiresat", "ttl"] },
  { canonical: "security", aliases: ["security", "secure", "safe", "protect", "permission", "acl", "rbac", "access-control", "safety", "vulnerability", "seguranca"] },
  { canonical: "middleware", aliases: ["middleware", "interceptor", "filter", "filtro", "hook", "pipe", "chain"] },
  { canonical: "permission", aliases: ["permission", "role", "access", "allow", "deny", "policy", "capability", "scope", "privilege", "permissao", "papel"] },
  { canonical: "isolation", aliases: ["isolation", "isolated", "separate", "sandbox", "compartment", "boundary", "partition", "scope", "scoped", "isolamento"] },
  { canonical: "api", aliases: ["api", "endpoint", "route", "rota", "rest", "graphql", "rpc", "handler", "controller", "controlador"] },
  { canonical: "database", aliases: ["database", "db", "sql", "query", "consulta", "banco", "collection", "model", "schema", "store", "repository", "repositorio"] },
  { canonical: "builder", aliases: ["builder", "build", "construct", "factory", "generator", "creator", "page-builder", "pagebuilder", "editor"] },
  { canonical: "public", aliases: ["public", "publico", "client", "frontend", "customer", "user-facing", "external", "open", "unauthenticated", "anonymous"] },
];

const WEAK_GOAL_KEYWORDS = new Set([
  "admin", "app", "page", "web", "site", "data", "route", "rota", "component", "src", "index",
  "public", "publico", "client", "customer", "frontend", "external", "open", "user-facing", "user", "usuario",
]);

const STRONG_GOAL_KEYWORDS = new Set([
  "jwt", "oauth", "token", "token_expired", "auth:logout", "authentication", "autenticacao",
  "tokens", "expiration", "expiracao", "expired", "expirado", "expires", "expiresat",
  "password", "senha", "credential", "credencial", "sql", "database", "db", "query", "graphql",
  "rbac", "acl", "vulnerability", "401", "expiration", "expiracao",
]);

function normalizeToken(t: string): string {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const SYNONYM_LOOKUP = new Map<string, SynonymGroup>();
for (const group of SYNONYM_GROUPS) {
  for (const alias of group.aliases) {
    const normalizedAlias = normalizeToken(alias);
    if (!SYNONYM_LOOKUP.has(normalizedAlias)) {
      SYNONYM_LOOKUP.set(normalizedAlias, group);
    }
  }
}

function keywordStrength(
  value: string,
  origin: GoalKeywordOrigin,
  canonical?: string,
): GoalKeywordStrength {
  if (canonical === "public" || WEAK_GOAL_KEYWORDS.has(value)) return "weak";
  if (origin === "explicit" && STRONG_GOAL_KEYWORDS.has(value)) return "strong";
  return "normal";
}

function signalRank(signal: GoalKeywordSignal): number {
  if (signal.origin === "explicit" && signal.strength === "strong") return 0;
  if (signal.origin === "explicit" && signal.strength === "normal") return 1;
  if (signal.origin === "expanded" && signal.strength === "normal") return 2;
  if (signal.origin === "explicit" && signal.strength === "weak") return 3;
  return 4;
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
  // Extract explicit file paths (things with / or .ts, .js, etc. without whitespace inside)
  const pathMatches = Array.from(goal.matchAll(/(?:[a-zA-Z0-9_-]+[\\/])+[a-zA-Z0-9_.-]+|[a-zA-Z0-9_-]+\.(?:ts|js|tsx|jsx|json|md|py|go|rs|cpp|h|css|html)\b/g));
  const extractedPaths = pathMatches
    .map((match) => match[0].replace(/\\/g, "/"))
    .filter(p => !p.startsWith("http://") && !p.startsWith("https://"));

  // Paths are handled as sovereign evidence. Remove them before lexical tokenization
  // so fragments such as src, app and tsx do not pollute semantic ranking.
  let lexicalGoal = goal;
  for (const match of pathMatches) lexicalGoal = lexicalGoal.replace(match[0], " ");

  const normalizedLexicalGoal = normalizeToken(lexicalGoal);
  const rawTokens = normalizedLexicalGoal.match(/[a-z0-9]+(?::[a-z0-9_-]+)?(?:[_-][a-z0-9]+)*/g) ?? [];
  const tokens = rawTokens.filter((token) => !STOPWORDS.has(token) && token.length > 1);

  const signalsByValue = new Map<string, GoalKeywordSignal>();
  const insertionOrder = new Map<string, number>();
  let nextOrder = 0;

  const addSignal = (signal: GoalKeywordSignal) => {
    const existing = signalsByValue.get(signal.value);
    if (!existing) {
      signalsByValue.set(signal.value, signal);
      insertionOrder.set(signal.value, nextOrder++);
      return;
    }

    // Explicit terms always win over inferred synonyms. Within the same origin,
    // retain the stronger classification.
    if (
      (existing.origin === "expanded" && signal.origin === "explicit") ||
      (existing.origin === signal.origin && signalRank(signal) < signalRank(existing))
    ) {
      signalsByValue.set(signal.value, signal);
    }
  };

  for (const token of tokens) {
    const group = SYNONYM_LOOKUP.get(token);
    addSignal({
      value: token,
      origin: "explicit",
      strength: keywordStrength(token, "explicit", group?.canonical),
      canonical: group?.canonical,
    });

    if (!group) continue;
    for (const alias of group.aliases) {
      const value = normalizeToken(alias);
      if (value === token) continue;
      addSignal({
        value,
        origin: "expanded",
        strength: keywordStrength(value, "expanded", group.canonical),
        canonical: group.canonical,
      });
    }
  }

  const keywordSignals = [...signalsByValue.values()]
    .filter((signal) => signal.value.length > 2)
    .sort((a, b) => {
      const rankDiff = signalRank(a) - signalRank(b);
      if (rankDiff !== 0) return rankDiff;
      return (insertionOrder.get(a.value) ?? 0) - (insertionOrder.get(b.value) ?? 0);
    });

  const keywords = keywordSignals.map((signal) => signal.value);

  // anchorKeywords = expandedKeywords minus ACTION_WORDS (noun/adjective terms suitable for grep)
  const anchorKeywords = keywordSignals
    .filter((signal) => !ACTION_WORDS.has(signal.value))
    .map((signal) => signal.value);
  
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
    keywordSignals,
    extractedPaths: [...new Set(extractedPaths)],
    taskTypeSuggestion: finalTaskType,
    taskTypeSource,
  };
}
