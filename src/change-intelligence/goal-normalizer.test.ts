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
    assert.deepEqual(res2.tokens, ["corrigir", "autenticacao", "usuario"]);
    assert.ok(res2.expandedKeywords.includes("auth"));
    assert.ok(res2.expandedKeywords.includes("jwt"));
  });

  it("preserves explicit keyword origin and weakens generic public synonyms", () => {
    const result = normalizeGoal("refatorar JWT sem alterar contrato público");

    const jwt = result.keywordSignals.find((signal) => signal.value === "jwt");
    const publico = result.keywordSignals.find((signal) => signal.value === "publico");
    const customer = result.keywordSignals.find((signal) => signal.value === "customer");

    assert.deepEqual(jwt, {
      value: "jwt",
      origin: "explicit",
      strength: "strong",
      canonical: "auth",
    });
    assert.equal(publico?.origin, "explicit");
    assert.equal(publico?.strength, "weak");
    assert.equal(customer?.origin, "expanded");
    assert.equal(customer?.strength, "weak");
    assert.ok(result.anchorKeywords.indexOf("jwt") < result.anchorKeywords.indexOf("customer"));
  });

  it("uses exact synonym aliases instead of substring expansion", () => {
    const result = normalizeGoal("update publication metadata and authorization notes");

    assert.ok(!result.expandedKeywords.includes("customer"), "publication must not activate the public synonym group");
    assert.ok(!result.expandedKeywords.includes("jwt"), "authorization must not activate auth by substring");
  });

  it("removes explicit paths before lexical tokenization", () => {
    const result = normalizeGoal("fix src/app/payment/page.tsx auth flow");

    assert.ok(result.extractedPaths.includes("src/app/payment/page.tsx"));
    assert.ok(!result.tokens.includes("src"));
    assert.ok(!result.tokens.includes("tsx"));
    assert.ok(result.tokens.includes("auth"));
  });

  it("expands token expiration morphology without generic task noise", () => {
    const result = normalizeGoal(
      "Identificar a lógica de autenticação JWT e o tratamento de expiração de tokens",
    );

    assert.ok(!result.anchorKeywords.includes("identificar"));
    assert.ok(!result.anchorKeywords.includes("logica"));
    assert.ok(!result.anchorKeywords.includes("tratamento"));
    assert.ok(result.anchorKeywords.includes("tokens"));
    assert.ok(result.anchorKeywords.includes("expirado"));
    assert.ok(result.anchorKeywords.includes("expiresat"));
    assert.ok(
      result.anchorKeywords.indexOf("tokens") < result.anchorKeywords.indexOf("auth"),
      "explicit token term must precede inferred auth aliases",
    );
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
