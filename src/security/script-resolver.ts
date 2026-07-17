export interface CollectPackageScriptsOptions {
  packageJson: any;
  scriptName: string;
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Canonical invocation patterns we fully understand (group 1 = script name).
// ---------------------------------------------------------------------------
// npm  [--silent|-q|--quiet]  run[-script]  [--silent|-q|--quiet]  <name>
// pnpm [--silent|-q|--quiet]  run[-script]  [--silent|-q|--quiet]  <name>
const NPM_CANONICAL_RE =
  /\b(?:npm|pnpm)\s+(?:(?:--silent|-q|--quiet)\s+)?run(?:-script)?\s+(?:(?:--silent|-q|--quiet)\s+)?([a-zA-Z0-9_][a-zA-Z0-9_.:@/-]*)\b/g;

// yarn [run]  <name>
const YARN_CANONICAL_RE =
  /\byarn(?:\s+run)?\s+([a-zA-Z0-9_][a-zA-Z0-9_.:@/-]*)\b/g;

// Broad detector — any npm/yarn/pnpm keyword
const PKG_MGR_RE = /\b(?:npm|pnpm|yarn)\b/g;

/**
 * Extract all nested script names from `scriptContent`.
 *
 * Fail-closed: if any `npm`, `pnpm`, or `yarn` keyword appears at a position
 * that is NOT covered by a canonical invocation pattern, an error is thrown
 * instead of silently falling back to literal evaluation.
 */
function extractSubScriptNames(scriptContent: string, scriptName: string): string[] {
  const content = String(scriptContent);

  // Collect positions of all package-manager keywords.
  const pkgMgrPositions: number[] = [];
  {
    const re = new RegExp(PKG_MGR_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      pkgMgrPositions.push(m.index);
    }
  }

  if (pkgMgrPositions.length === 0) return [];

  // Collect canonical matches and their start positions + script names.
  const coveredPositions = new Set<number>();
  const subNames: string[] = [];

  const collect = (re: RegExp) => {
    const r = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(content)) !== null) {
      coveredPositions.add(m.index);
      const name = m[1];
      // Guard: canonical patterns start names with [a-zA-Z0-9_], never with '-'
      if (name && !name.startsWith("-")) {
        subNames.push(name);
      }
    }
  };

  collect(NPM_CANONICAL_RE);
  collect(YARN_CANONICAL_RE);

  // Fail-closed: every pkg-manager keyword must be covered by a canonical match.
  for (const pos of pkgMgrPositions) {
    if (!coveredPositions.has(pos)) {
      const snippet = content.slice(Math.max(0, pos), pos + 60);
      throw new Error(
        `Unsupported package-manager invocation in script "${scriptName}" at position ${pos}: "${snippet}". ` +
          `Only canonical forms (npm run <name>, pnpm run <name>, yarn [run] <name>) are allowed. ` +
          `Use --silent/-q before or after "run", no other flags.`,
      );
    }
  }

  return subNames;
}

export function collectPackageScriptCommands({
  packageJson,
  scriptName,
  maxDepth = 10,
}: CollectPackageScriptsOptions): string[] {
  if (!packageJson || !packageJson.scripts) return [];

  const visited = new Set<string>();
  const commandsToValidate: string[] = [];

  function expandScript(name: string, depth: number) {
    if (depth > maxDepth) {
      throw new Error(`Max script depth exceeded for script: ${name}`);
    }

    if (visited.has(name)) {
      throw new Error(`Cyclic script execution detected: ${name}`);
    }
    visited.add(name);

    const scriptContent = packageJson.scripts[name];
    if (!scriptContent) {
      visited.delete(name);
      return;
    }

    // Always push the literal script content so the policy can evaluate it.
    commandsToValidate.push(String(scriptContent));

    // Extract sub-script names — throws on any unrecognised pkg-manager syntax.
    const subNames = extractSubScriptNames(String(scriptContent), name);

    for (const subName of subNames) {
      if (packageJson.scripts[subName]) {
        if (packageJson.scripts[`pre${subName}`]) {
          expandScript(`pre${subName}`, depth + 1);
        }

        expandScript(subName, depth + 1);

        if (packageJson.scripts[`post${subName}`]) {
          expandScript(`post${subName}`, depth + 1);
        }
      }
    }

    // Remove from the call stack so sibling branches can reuse the same script.
    visited.delete(name);
  }

  // Pre-hook
  if (packageJson.scripts[`pre${scriptName}`]) {
    expandScript(`pre${scriptName}`, 0);
  }

  // The actual script
  expandScript(scriptName, 0);

  // Post-hook
  if (packageJson.scripts[`post${scriptName}`]) {
    expandScript(`post${scriptName}`, 0);
  }

  return commandsToValidate;
}
