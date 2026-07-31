import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containsKeywordBoundary,
  rankCandidateAssessments,
  selectContentSearchSignals,
  type CandidateKeywordMatch,
} from "./candidate-ranking.js";
import type { GoalKeywordSignal } from "./goal-normalizer.js";
import type {
  CandidateKind,
  EvidenceEntry,
  EvidenceType,
} from "./types.js";

function signal(
  value: string,
  origin: GoalKeywordSignal["origin"],
  strength: GoalKeywordSignal["strength"],
  canonical?: string,
): GoalKeywordSignal {
  return { value, origin, strength, canonical };
}

function match(
  goalSignal: GoalKeywordSignal,
  evidenceTypes: EvidenceType[],
): CandidateKeywordMatch {
  return {
    ...goalSignal,
    evidenceTypes: new Set(evidenceTypes),
  };
}

function rank(
  entries: Array<[string, EvidenceEntry[]]>,
  keywordSignals: GoalKeywordSignal[],
  keywordMatchesByPath: Map<string, Map<string, CandidateKeywordMatch>>,
  kinds: Record<string, CandidateKind> = {},
) {
  return rankCandidateAssessments(entries, {
    intent: "implementation",
    keywordSignals,
    keywordMatchesByPath,
    getKind: (path) => kinds[path] ?? "source",
  });
}

describe("candidate-ranking", () => {
  it("ranks explicit strong anchors above weak expanded synonyms", () => {
    const jwt = signal("jwt", "explicit", "strong", "auth");
    const customer = signal("customer", "expanded", "weak", "public");
    const candidates: Array<[string, EvidenceEntry[]]> = [
      [
        "src/customer-dashboard.ts",
        [
          { type: "filename_exact", detail: "customer" },
          { type: "content_match", detail: "customer" },
        ],
      ],
      [
        "src/auth/token-service.ts",
        [
          { type: "filename_exact", detail: "jwt" },
          { type: "content_match", detail: "jwt" },
        ],
      ],
    ];
    const matches = new Map<string, Map<string, CandidateKeywordMatch>>([
      [
        "src/customer-dashboard.ts",
        new Map([
          [
            "customer",
            match(customer, ["filename_exact", "content_match"]),
          ],
        ]),
      ],
      [
        "src/auth/token-service.ts",
        new Map([
          ["jwt", match(jwt, ["filename_exact", "content_match"])],
        ]),
      ],
    ]);

    const ranked = rank(candidates, [jwt, customer], matches);

    assert.equal(ranked[0].path, "src/auth/token-service.ts");
    assert.ok(ranked[0].score > ranked[1].score);
    assert.equal(ranked[1].confidence, "medium");
  });

  it("is deterministic when candidate insertion order changes", () => {
    const api = signal("api", "explicit", "normal", "api");
    const query = signal("query", "explicit", "strong", "database");
    const entries: Array<[string, EvidenceEntry[]]> = [
      ["src/api.ts", [{ type: "filename_exact", detail: "api" }]],
      ["src/query.ts", [{ type: "filename_exact", detail: "query" }]],
      ["src/service.ts", [{ type: "content_match", detail: "api, query" }]],
    ];
    const matches = new Map<string, Map<string, CandidateKeywordMatch>>([
      ["src/api.ts", new Map([["api", match(api, ["filename_exact"])]] )],
      ["src/query.ts", new Map([["query", match(query, ["filename_exact"])]] )],
      [
        "src/service.ts",
        new Map([
          ["api", match(api, ["content_match"])],
          ["query", match(query, ["content_match"])],
        ]),
      ],
    ]);

    const forward = rank(entries, [query, api], matches).map((item) => item.path);
    const reversed = rank([...entries].reverse(), [query, api], matches).map(
      (item) => item.path,
    );

    assert.deepEqual(reversed, forward);
  });

  it("blocks style files from primary and auto-read for backend goals", () => {
    const api = signal("api", "explicit", "normal", "api");
    const database = signal("database", "explicit", "strong", "database");
    const path = "src/styles/api-table.css";
    const ranked = rank(
      [
        [
          path,
          [
            { type: "filename_exact", detail: "api" },
            { type: "content_match", detail: "database" },
          ],
        ],
      ],
      [database, api],
      new Map([
        [
          path,
          new Map([
            ["api", match(api, ["filename_exact"])],
            ["database", match(database, ["content_match"])],
          ]),
        ],
      ]),
    );

    assert.equal(ranked[0].primaryEligible, false);
    assert.equal(ranked[0].autoReadEligible, false);
    assert.ok(
      ranked[0].rejectionReasons.includes(
        "style_file_incompatible_with_backend_goal",
      ),
    );
  });

  it("balances content-search terms across strong semantic groups", () => {
    const signals = [
      signal("jwt", "explicit", "strong", "auth"),
      signal("tokens", "explicit", "strong", "auth"),
      signal("auth", "expanded", "normal", "auth"),
      signal("expiracao", "explicit", "strong", "expiration"),
      signal("expired", "expanded", "normal", "expiration"),
      signal("customer", "expanded", "weak", "public"),
    ];

    const selected = selectContentSearchSignals(
      signals,
      new Set(signals.map((item) => item.value)),
      5,
    ).map((item) => item.value);

    assert.ok(selected.includes("jwt"));
    assert.ok(selected.includes("expiracao"));
    assert.ok(!selected.includes("customer"));
    assert.equal(new Set(selected).size, selected.length);
  });

  it("matches identifier boundaries without short substring false positives", () => {
    assert.equal(containsKeywordBoundary("const expiresAt = now + ttl", "expiresat"), true);
    assert.equal(containsKeywordBoundary("authorization notes", "auth"), false);
    assert.equal(containsKeywordBoundary("publication metadata", "public"), false);
  });
});
