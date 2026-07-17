export interface CollectPackageScriptsOptions {
  packageJson: any;
  scriptName: string;
  maxDepth?: number;
}

export function collectPackageScriptCommands({
  packageJson,
  scriptName,
  maxDepth = 10,
}: CollectPackageScriptsOptions): string[] {
  if (!packageJson || !packageJson.scripts) return [];

  const visited = new Set<string>();
  const commandsToValidate: string[] = [];

  const subScriptRegex = /(?:npm|yarn|pnpm)(?:\s+(?:--silent|-q|--quiet))?\s+(?:run|run-script)?\s+([a-zA-Z0-9_.:@/-]+)/g;

  function expandScript(name: string, depth: number) {
    if (depth > maxDepth) {
      throw new Error(`Max script depth exceeded for script: ${name}`);
    }

    if (visited.has(name)) {
      throw new Error(`Cyclic script execution detected: ${name}`);
    }
    visited.add(name);

    const scriptContent = packageJson.scripts[name];
    if (!scriptContent) return;

    // Always push the literal script content to be evaluated
    commandsToValidate.push(String(scriptContent));

    // Use matchAll to avoid stateful /g regex issues during recursion
    const matches = Array.from(String(scriptContent).matchAll(subScriptRegex));
    for (const match of matches) {
      const subName = match[1];

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
    
    // Once we return from recursion, we must remove it from `visited`
    // so that other branches in the script tree can legitimately call the same subscript.
    // Wait, npm run execution graph allows the same script to be run multiple times
    // in different subtrees. BUT to prevent true infinite cycles, we track the call stack.
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
