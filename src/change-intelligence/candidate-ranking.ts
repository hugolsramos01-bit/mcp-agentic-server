import { basename } from "node:path";
import type {
  GoalKeywordSignal,
} from "./goal-normalizer.js";
import {
  inferConfidence,
  EVIDENCE_WEIGHTS,
  KIND_PENALTIES,
} from "./evidence.js";
import {
  candidateKindPriority,
  isLockFile,
  isPrimaryEligibleKind,
} from "./indexed-path.js";
import type {
  CandidateAssessment,
  CandidateKind,
  EvidenceEntry,
  EvidenceType,
  GoalIntent,
} from "./types.js";

export type CandidateKeywordMatch = GoalKeywordSignal & {
  evidenceTypes: Set<EvidenceType>;
};

export interface CandidateRankingContext {
  intent: GoalIntent;
  keywordSignals: readonly GoalKeywordSignal[];
  keywordMatchesByPath: ReadonlyMap<
    string,
    ReadonlyMap<string, CandidateKeywordMatch>
  >;
  getKind(path: string): CandidateKind;
}

export interface ContentMatchCandidate {
  path: string;
  kind: CandidateKind;
  matched: ReadonlySet<string>;
}

const STYLE_FILE_PATTERN = /\.(?:css|scss|sass|less|styl)$/i;
const GENERIC_IMPLEMENTATION_FILE_PATTERN =
  /(?:^|[-_.])(?:api|service|repository|repositorio|store|handler|controller|controlador|guard|middleware|query|database|db|auth|token|session|account|setup|verification|verify)(?:[-_.]|$)/i;
const FRONTEND_GOAL_TERMS = new Set([
  "css",
  "scss",
  "sass",
  "style",
  "styles",
  "layout",
  "visual",
  "ui",
  "frontend",
  "component",
]);

const SEARCH_TERM_PRIORITY: Record<string, string[]> = {
  auth: [
    "jwt",
    "tokens",
    "token",
    "auth",
    "oauth",
    "session",
    "login",
    "authentication",
    "autenticacao",
  ],
  expiration: [
    "expiracao",
    "expirado",
    "expired",
    "expiresat",
    "expires",
    "expiration",
    "expira",
    "ttl",
  ],
  api: ["api", "endpoint", "handler", "controller", "route", "rota"],
  database: [
    "sql",
    "database",
    "db",
    "query",
    "consulta",
    "banco",
    "repository",
    "repositorio",
  ],
};

function searchTermPriority(signal: GoalKeywordSignal): number {
  const ordered = signal.canonical
    ? SEARCH_TERM_PRIORITY[signal.canonical]
    : undefined;
  const index = ordered?.indexOf(signal.value) ?? -1;
  return index === -1 ? 100 : index;
}

export function selectContentSearchSignals(
  signals: readonly GoalKeywordSignal[],
  anchorKeywords: ReadonlySet<string>,
  maxSignals = 5,
): GoalKeywordSignal[] {
  const eligible = signals.filter(
    (signal) =>
      anchorKeywords.has(signal.value) &&
      signal.value.length >= 3 &&
      (signal.strength !== "weak" || signal.origin === "explicit"),
  );

  const selected: GoalKeywordSignal[] = [];
  const selectedValues = new Set<string>();
  const add = (signal: GoalKeywordSignal | undefined) => {
    if (
      !signal ||
      selected.length >= maxSignals ||
      selectedValues.has(signal.value)
    ) {
      return;
    }
    selected.push(signal);
    selectedValues.add(signal.value);
  };

  const canonicalGroups = new Map<string, GoalKeywordSignal[]>();
  for (const signal of eligible) {
    if (!signal.canonical) continue;
    const group = canonicalGroups.get(signal.canonical) ?? [];
    group.push(signal);
    canonicalGroups.set(signal.canonical, group);
  }

  const strongCanonicalGroups = [...canonicalGroups.entries()]
    .filter(([, group]) =>
      group.some(
        (signal) =>
          signal.origin === "explicit" && signal.strength === "strong",
      ),
    )
    .sort((a, b) => {
      const aIndex = eligible.indexOf(a[1][0]);
      const bIndex = eligible.indexOf(b[1][0]);
      return aIndex - bIndex;
    });

  for (const [, group] of strongCanonicalGroups) {
    const explicit = group
      .filter(
        (signal) =>
          signal.origin === "explicit" && signal.strength !== "weak",
      )
      .sort((a, b) => {
        const priority = searchTermPriority(a) - searchTermPriority(b);
        return priority !== 0
          ? priority
          : eligible.indexOf(a) - eligible.indexOf(b);
      });
    add(explicit[0]);
    add(explicit[1]);
  }

  for (const [, group] of strongCanonicalGroups) {
    const expanded = group
      .filter(
        (signal) =>
          signal.origin === "expanded" && signal.strength !== "weak",
      )
      .sort((a, b) => {
        const priority = searchTermPriority(a) - searchTermPriority(b);
        return priority !== 0
          ? priority
          : eligible.indexOf(a) - eligible.indexOf(b);
      });
    add(expanded[0]);
  }

  for (const signal of eligible) add(signal);
  return selected;
}

export function selectBalancedContentMatches(
  candidates: readonly ContentMatchCandidate[],
  signals: readonly GoalKeywordSignal[],
  limit = 20,
): ContentMatchCandidate[] {
  if (limit <= 0 || candidates.length === 0) return [];

  const signalOrder = new Map(
    signals.map((signal, index) => [signal.value, index]),
  );
  const conceptOrder: string[] = [];
  const conceptKeywords = new Map<string, Set<string>>();

  for (const signal of signals) {
    const concept = signal.canonical ?? signal.value;
    if (!conceptKeywords.has(concept)) {
      conceptOrder.push(concept);
      conceptKeywords.set(concept, new Set());
    }
    conceptKeywords.get(concept)!.add(signal.value);
  }

  const compareWithinConcept = (
    a: ContentMatchCandidate,
    b: ContentMatchCandidate,
  ): number => {
    const kindDiff =
      candidateKindPriority(a.kind) - candidateKindPriority(b.kind);
    if (kindDiff !== 0) return kindDiff;
    if (a.matched.size !== b.matched.size) return b.matched.size - a.matched.size;
    const bestA = Math.min(
      ...[...a.matched].map((keyword) => signalOrder.get(keyword) ?? 999),
    );
    const bestB = Math.min(
      ...[...b.matched].map((keyword) => signalOrder.get(keyword) ?? 999),
    );
    if (bestA !== bestB) return bestA - bestB;
    return a.path.localeCompare(b.path);
  };

  const buckets = new Map<string, ContentMatchCandidate[]>();
  for (const concept of conceptOrder) {
    const keywords = conceptKeywords.get(concept)!;
    buckets.set(
      concept,
      candidates
        .filter((candidate) =>
          [...candidate.matched].some((keyword) => keywords.has(keyword)),
        )
        .sort(compareWithinConcept),
    );
  }

  const selected: ContentMatchCandidate[] = [];
  const selectedPaths = new Set<string>();
  const positions = new Map(conceptOrder.map((concept) => [concept, 0]));

  while (selected.length < limit) {
    let progressed = false;
    for (const concept of conceptOrder) {
      const bucket = buckets.get(concept) ?? [];
      let position = positions.get(concept) ?? 0;
      while (position < bucket.length && selectedPaths.has(bucket[position].path)) {
        position++;
      }
      positions.set(concept, position + 1);
      if (position >= bucket.length) continue;

      const candidate = bucket[position];
      selected.push(candidate);
      selectedPaths.add(candidate.path);
      progressed = true;
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }

  return selected;
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function containsKeywordBoundary(
  text: string,
  keyword: string,
): boolean {
  const normalizedText = normalizeSearchText(text);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(
      normalizedText,
    )
  ) {
    return true;
  }

  if (keyword.length < 8) return false;
  const compactText = normalizedText.replace(/[^a-z0-9]/g, "");
  const compactKeyword = keyword.replace(/[^a-z0-9]/g, "");
  return compactText.includes(compactKeyword);
}

function keywordEvidenceMultiplier(signal: GoalKeywordSignal): number {
  if (signal.origin === "explicit") {
    if (signal.strength === "strong") return 1.25;
    if (signal.strength === "normal") return 1;
    return 0.2;
  }
  if (signal.strength === "strong") return 0.75;
  if (signal.strength === "normal") return 0.55;
  return 0.1;
}

function isStyleFileIncompatibleWithGoal(
  path: string,
  signals: readonly GoalKeywordSignal[],
): boolean {
  if (!STYLE_FILE_PATTERN.test(path)) return false;

  const hasExplicitFrontendGoal = signals.some(
    (signal) =>
      signal.origin === "explicit" && FRONTEND_GOAL_TERMS.has(signal.value),
  );
  if (hasExplicitFrontendGoal) return false;

  return signals.some(
    (signal) =>
      signal.strength !== "weak" &&
      (signal.canonical === "api" || signal.canonical === "database"),
  );
}

function getKeywordMatches(
  path: string,
  context: CandidateRankingContext,
): CandidateKeywordMatch[] {
  return [...(context.keywordMatchesByPath.get(path)?.values() ?? [])];
}

function getEvidenceKeywordMatches(
  path: string,
  evidenceType: EvidenceType,
  context: CandidateRankingContext,
): CandidateKeywordMatch[] {
  return getKeywordMatches(path, context).filter((match) =>
    match.evidenceTypes.has(evidenceType),
  );
}

export function inferCandidateConfidence(
  path: string,
  evidence: readonly EvidenceEntry[],
  context: CandidateRankingContext,
) {
  let confidence = inferConfidence(evidence);
  const hasSovereignEvidence = evidence.some(
    (entry) => entry.type === "focus_path" || entry.type === "extracted_path",
  );
  if (hasSovereignEvidence) return confidence;

  const matches = getKeywordMatches(path, context);
  const normalizedFullBasename = basename(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const hasExplicitFullFilenameMatch = matches.some(
    (match) =>
      match.evidenceTypes.has("filename_exact") &&
      match.origin === "explicit" &&
      match.strength !== "weak" &&
      normalizedFullBasename === match.value,
  );
  if (hasExplicitFullFilenameMatch) return "high" as const;

  const explicitNonWeakMatches = matches.filter(
    (match) => match.origin === "explicit" && match.strength !== "weak",
  );
  const nonWeakCanonicalConcepts = new Set(
    matches
      .filter((match) => match.strength !== "weak" && match.canonical)
      .map((match) => match.canonical),
  );
  const hasContentMatch = evidence.some(
    (entry) => entry.type === "content_match",
  );
  const implementationShapedFilename = GENERIC_IMPLEMENTATION_FILE_PATTERN.test(
    basename(path),
  );

  if (
    confidence !== "high" &&
    hasContentMatch &&
    (explicitNonWeakMatches.length >= 2 ||
      nonWeakCanonicalConcepts.size >= 2) &&
    implementationShapedFilename
  ) {
    confidence = "high";
  }

  if (
    matches.length > 0 &&
    matches.every((match) => match.strength === "weak") &&
    confidence === "high"
  ) {
    confidence = "medium";
  }

  if (
    isStyleFileIncompatibleWithGoal(path, context.keywordSignals) &&
    confidence === "high"
  ) {
    confidence = "medium";
  }
  if (isLockFile(path) && confidence === "high") confidence = "medium";

  return confidence;
}

function compareCandidateAssessments(
  a: CandidateAssessment,
  b: CandidateAssessment,
): number {
  if (b.score !== a.score) return b.score - a.score;

  const kindDiff =
    candidateKindPriority(a.kind) - candidateKindPriority(b.kind);
  if (kindDiff !== 0) return kindDiff;

  const strongA = a.evidence.filter(
    (entry) =>
      (EVIDENCE_WEIGHTS[
        entry.type as keyof typeof EVIDENCE_WEIGHTS
      ] ?? 0) >= 35,
  ).length;
  const strongB = b.evidence.filter(
    (entry) =>
      (EVIDENCE_WEIGHTS[
        entry.type as keyof typeof EVIDENCE_WEIGHTS
      ] ?? 0) >= 35,
  ).length;
  if (strongA !== strongB) return strongB - strongA;

  return a.path.localeCompare(b.path);
}

export function rankCandidateAssessments(
  candidateEntries: Iterable<[string, EvidenceEntry[]]>,
  context: CandidateRankingContext,
): CandidateAssessment[] {
  const assessments = Array.from(candidateEntries).map(([path, evidence]) => {
    const kind = context.getKind(path);
    const confidence = inferCandidateConfidence(path, evidence, context);

    let score = 0;
    for (const entry of evidence) {
      const baseWeight =
        EVIDENCE_WEIGHTS[
          entry.type as keyof typeof EVIDENCE_WEIGHTS
        ] || 0;
      const keywordMatches = getEvidenceKeywordMatches(
        path,
        entry.type,
        context,
      );
      if (keywordMatches.length === 0) {
        score += baseWeight;
        continue;
      }
      const strongestMultiplier = Math.max(
        ...keywordMatches.map(keywordEvidenceMultiplier),
      );
      score += Math.round(baseWeight * strongestMultiplier);
    }

    const keywordMatches = getKeywordMatches(path, context);
    const explicitNonWeak = keywordMatches.filter(
      (match) => match.origin === "explicit" && match.strength !== "weak",
    );
    const explicitStrong = explicitNonWeak.filter(
      (match) => match.strength === "strong",
    );
    const expandedNonWeak = keywordMatches.filter(
      (match) => match.origin === "expanded" && match.strength !== "weak",
    );
    score += Math.min(
      32,
      explicitNonWeak.length * 7 +
        explicitStrong.length * 5 +
        Math.min(expandedNonWeak.length, 3) * 2,
    );

    const normalizedFullBasename = basename(path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    if (
      keywordMatches.some(
        (match) =>
          match.evidenceTypes.has("filename_exact") &&
          match.origin === "explicit" &&
          match.strength !== "weak" &&
          normalizedFullBasename === match.value,
      )
    ) {
      score += 40;
    }
    if (
      keywordMatches.length > 0 &&
      keywordMatches.every((match) => match.strength === "weak")
    ) {
      score -= 25;
    }
    score -= KIND_PENALTIES[kind] || 0;

    const explicitlyFocused = evidence.some(
      (entry) => entry.type === "focus_path",
    );
    const explicitlySelected = evidence.some(
      (entry) =>
        entry.type === "focus_path" || entry.type === "extracted_path",
    );
    const styleIntentMismatch = isStyleFileIncompatibleWithGoal(
      path,
      context.keywordSignals,
    );
    if (styleIntentMismatch && !explicitlySelected) score -= 60;

    let primaryEligible = isPrimaryEligibleKind(kind) || explicitlyFocused;
    if (kind === "test") primaryEligible = false;
    if (context.intent === "testing" && kind === "test") {
      primaryEligible = true;
    }
    if (context.intent === "configuration" && kind === "configuration") {
      primaryEligible = true;
    }
    if (styleIntentMismatch && !explicitlySelected) primaryEligible = false;
    if (isLockFile(path) && !explicitlySelected) primaryEligible = false;

    let autoReadEligible = true;
    if (kind === "generated" || isLockFile(path)) autoReadEligible = false;
    if (styleIntentMismatch && !explicitlySelected) autoReadEligible = false;
    if (explicitlySelected && kind !== "generated") autoReadEligible = true;

    const eligibilityReasons: string[] = [];
    if (primaryEligible) eligibilityReasons.push("primary_eligible");
    if (!autoReadEligible) eligibilityReasons.push("auto_read_blocked");

    const rejectionReasons: string[] = [];
    if (styleIntentMismatch && !explicitlySelected) {
      rejectionReasons.push("style_file_incompatible_with_backend_goal");
    }

    return {
      path,
      kind,
      evidence,
      score,
      confidence,
      primaryEligible,
      autoReadEligible,
      eligibilityReasons,
      rejectionReasons,
    } satisfies CandidateAssessment;
  });

  return assessments.sort(compareCandidateAssessments);
}
