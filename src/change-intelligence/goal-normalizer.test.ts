import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGoal } from "./goal-normalizer.js";

describe("goal-normalizer", () => {
  it("extracts stopwords and expands synonyms (EN & PT)", () => {
    const res1 = normalizeGoal("tenant security and admin isolation");
    assert.deepEqual(res1.tokens, ["tenant", "security", "admin", "isolation"]);
    // Should include synonms like 'org', 'account', 'safe', 'compartment'
    assert.ok(res1.expandedKeywords.includes("org"));
    assert.ok(res1.expandedKeywords.includes("safe"));
    assert.ok(res1.expandedKeywords.includes("sandbox"));

    const res2 = normalizeGoal("corrigir autenticacao do usuario");
    // 'do' is stopword, 'usuario' might stay
    assert.deepEqual(res2.tokens, ["corrigir", "autenticacao", "usuario"]);
    // 'autenticacao' matches 'auth' synonyms somewhat, wait, 'autenticacao' has no direct match in synonyms for auth unless we add it, but 'auth' might match.
    // 'auth' is in the syn list. 'autenticacao' contains 'auth' if we are not careful? No, it contains 'aut'.
  });

  it("extracts paths", () => {
    const res = normalizeGoal("adicionar rota de pagamento em src/app/payment/page.tsx e schema.ts");
    assert.ok(res.extractedPaths.includes("src/app/payment/page.tsx"));
    assert.ok(res.extractedPaths.includes("schema.ts"));
  });

  it("infers task type correctly", () => {
    assert.equal(normalizeGoal("corrigir autenticacao do usuario").taskTypeSuggestion, "bug_fix");
    assert.equal(normalizeGoal("adicionar rota de pagamento").taskTypeSuggestion, "feature");
    assert.equal(normalizeGoal("migrar schema do banco").taskTypeSuggestion, "migration");
  });

  it("prioritizes explicit type", () => {
    const res = normalizeGoal("corrigir autenticacao do usuario", "feature");
    assert.equal(res.taskTypeSuggestion, "feature");
    assert.equal(res.taskTypeSource, "explicit");
  });

  it("P1.2: anchorKeywords exclude ACTION_WORDS (suporte, bug, feature, issue)", () => {
    // 'suporte' (noun) should be filtered from anchors; only domain words remain
    const res1 = normalizeGoal("adicionar suporte para JWT middleware em auth");
    assert.ok(!res1.anchorKeywords.includes("suporte"), "suporte must be excluded from anchors");
    assert.ok(!res1.anchorKeywords.includes("adicionar"), "adicionar must be excluded from anchors");
    assert.ok(res1.anchorKeywords.includes("jwt"), "jwt must be in anchors");
    assert.ok(res1.anchorKeywords.includes("middleware"), "middleware must be in anchors");
    assert.ok(res1.anchorKeywords.includes("auth"), "auth must be in anchors");

    // Generic nouns bug/feature/issue
    const res2 = normalizeGoal("fix bug in login feature");
    assert.ok(!res2.anchorKeywords.includes("bug"), "bug must be excluded from anchors");
    assert.ok(!res2.anchorKeywords.includes("feature"), "feature must be excluded from anchors");
    assert.ok(res2.anchorKeywords.includes("fix") || res2.anchorKeywords.includes("login"), "login may remain if not stopword");
  });
});
