export type CheckTier =
  | "static_analysis"
  | "unit_tests"
  | "general_tests"
  | "integration_tests"
  | "smoke_tests"
  | "build"
  | "e2e_tests"
  | "other";

export type ConfidenceLevel = "low" | "medium" | "high";
export type CostLevel = "low" | "medium" | "high";
export type PackageManager = "npm" | "pnpm" | "yarn";

export interface ClassifiedCheck {
  script: string;
  command: string;
  tier: CheckTier;
  reason: string;
  confidence: ConfidenceLevel;
  mutatesWorkspace: boolean;
  estimatedCost: CostLevel;
}

export function classifyPackageScripts(
  scripts: Record<string, string>,
  packageManager: PackageManager
): ClassifiedCheck[] {
  const result: ClassifiedCheck[] = [];

  for (const [script, rawCommand] of Object.entries(scripts)) {
    const isMutating =
      script === "format" ||
      script === "format:write" ||
      script === "lint:fix" ||
      script === "test:update" ||
      script === "snapshot:update" ||
      rawCommand.includes("--write") ||
      rawCommand.includes("--fix");

    const cmdPrefix =
      packageManager === "npm"
        ? script === "test" || script === "start"
          ? "npm"
          : "npm run"
        : packageManager;
    const command = `${cmdPrefix} ${script}`;

    let tier: CheckTier = "other";
    let confidence: ConfidenceLevel = "low";
    let mutatesWorkspace = isMutating;
    let estimatedCost: CostLevel = "medium";
    let reason = "Classificação pendente";

    if (script === "typecheck" || script === "lint" || script === "lint:check" || script === "format:check" || script === "prettier:check") {
      tier = "static_analysis";
      confidence = "high";
      estimatedCost = "low";
      reason = script === "typecheck"
        ? "Valida tipos estatisticamente sem gerar artefatos"
        : "Verifica estilo/código estaticamente";
    } else if (script === "test:unit" || script === "unit") {
      tier = "unit_tests";
      confidence = "high";
      estimatedCost = "medium";
      reason = "Executa a suíte de testes unitários isolados";
    } else if (script === "test") {
      tier = "general_tests";
      confidence = "medium";
      estimatedCost = "medium";
      reason = "Executa a suíte geral declarada pelo projeto";
    } else if (script === "test:integration") {
      tier = "integration_tests";
      confidence = "high";
      estimatedCost = "high";
      reason = "Valida integração entre múltiplos componentes";
    } else if (
      script === "test:smoke" ||
      script === "smoke" ||
      script === "smoke:package" ||
      script === "ci:verify" ||
      script === "verify:ci"
    ) {
      tier = "smoke_tests";
      confidence = "high";
      estimatedCost = script.includes("ci") ? "high" : "low";
      reason = script.includes("ci")
        ? "Executa a verificação declarada para o pipeline de integração contínua"
        : "Verificação rápida de inicialização ou pacote gerado";
    } else if (script === "build" || script === "build:app") {
      tier = "build";
      confidence = "high";
      estimatedCost = "high";
      reason = "Garante compilação e criação dos artefatos";
    } else if (script === "test:http" || script === "test:e2e" || script === "e2e") {
      tier = "e2e_tests";
      confidence = "medium"; // could be flaky
      estimatedCost = "high";
      reason = "Validação fim a fim ou interface primária do sistema";
    }

    result.push({
      script,
      command,
      tier,
      reason,
      confidence,
      mutatesWorkspace,
      estimatedCost,
    });
  }

  // Ordenação determinística (alfabética por nome de script) para estabilidade nos snapshots
  result.sort((a, b) => a.script.localeCompare(b.script));

  return result;
}
