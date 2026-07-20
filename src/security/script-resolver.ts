export interface CollectPackageScriptsOptions {
  packageJson: any;
  scriptName: string;
  maxDepth?: number;
}

/** Tokenizes the small, command-like subset accepted in package scripts.  Shell
 * operators are deliberately left as tokens so every package-manager invocation
 * can be inspected independently. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";") {
      if (current) { tokens.push(current); current = ""; }
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) tokens.push(ch + command[++i]);
      else tokens.push(ch);
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("Unterminated quote in package script.");
  if (current) tokens.push(current);
  return tokens;
}

const separators = new Set(["&&", "||", "|", ";"]);
const safeScriptName = /^[A-Za-z0-9_][A-Za-z0-9_.:@/-]*$/;

function takeValue(tokens: string[], index: number, scriptName: string, flag: string): [string, number] {
  const value = tokens[index + 1];
  if (!value || separators.has(value) || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag} in script "${scriptName}".`);
  }
  return [value, index + 2];
}

/** Parses known npm/pnpm/yarn forms. Unknown options fail closed. Workspace
 * invocations are validated literally; a root package.json cannot safely expand
 * a script owned by another workspace package. */
function parseInvocation(tokens: string[], start: number, parentScript: string): { nested?: string; next: number } {
  const manager = tokens[start];
  let i = start + 1;
  let workspaceTarget = false;
  const consumeCommonFlags = (allowedWithValue: Set<string>, allowedBare: Set<string>) => {
    while (tokens[i]?.startsWith("-")) {
      const flag = tokens[i];
      if (allowedBare.has(flag)) { i++; continue; }
      if (allowedWithValue.has(flag)) { [, i] = takeValue(tokens, i, parentScript, flag); workspaceTarget = true; continue; }
      throw new Error(`Unsupported ${manager} option "${flag}" in script "${parentScript}". Package-manager syntax must be explicitly supported.`);
    }
  };

  if (manager === "npm") {
    consumeCommonFlags(new Set(["--workspace", "-w"]), new Set(["--silent", "-q", "--quiet"]));
    if (tokens[i] !== "run" && tokens[i] !== "run-script") {
      throw new Error(`Unsupported npm invocation in script "${parentScript}".`);
    }
    i++;
    consumeCommonFlags(new Set(), new Set(["--silent", "-q", "--quiet"]));
  } else if (manager === "pnpm") {
    consumeCommonFlags(new Set(["--filter", "-F"]), new Set(["--silent", "-q", "--quiet", "--recursive", "-r"]));
    if (tokens[i] === "run" || tokens[i] === "run-script") {
      i++;
      consumeCommonFlags(new Set(), new Set(["--silent", "-q", "--quiet"]));
    }
  } else if (manager === "yarn") {
    if (tokens[i] === "workspace") {
      [, i] = takeValue(tokens, i, parentScript, "workspace");
      workspaceTarget = true;
    } else if (tokens[i] === "workspaces") {
      i++;
      if (tokens[i] !== "foreach") throw new Error(`Unsupported yarn workspaces invocation in script "${parentScript}".`);
      i++;
      consumeCommonFlags(new Set(), new Set(["--parallel", "--topological", "--verbose"]));
    }
    if (tokens[i] === "run") i++;
  }

  const nested = tokens[i];
  if (!nested || separators.has(nested) || nested.startsWith("-") || !safeScriptName.test(nested)) {
    throw new Error(`Could not determine the script name for ${manager} in script "${parentScript}".`);
  }
  return { nested: workspaceTarget ? undefined : nested, next: i + 1 };
}

function extractSubScriptNames(scriptContent: string, scriptName: string): string[] {
  const tokens = tokenize(String(scriptContent));
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "npm" && tokens[i] !== "pnpm" && tokens[i] !== "yarn") continue;
    const parsed = parseInvocation(tokens, i, scriptName);
    if (parsed.nested) names.push(parsed.nested);
    i = parsed.next - 1;
  }
  return names;
}

export function collectPackageScriptCommands({ packageJson, scriptName, maxDepth = 10 }: CollectPackageScriptsOptions): string[] {
  if (!packageJson?.scripts) return [];
  const active = new Set<string>();
  const commands: string[] = [];
  const expand = (name: string, depth: number) => {
    if (depth > maxDepth) throw new Error(`Max script depth exceeded for script: ${name}`);
    if (active.has(name)) throw new Error(`Cyclic script execution detected: ${name}`);
    const content = packageJson.scripts[name];
    if (!content) return;
    active.add(name);
    commands.push(String(content));
    for (const nested of extractSubScriptNames(String(content), name)) {
      if (!packageJson.scripts[nested]) continue;
      expand(`pre${nested}`, depth + 1);
      expand(nested, depth + 1);
      expand(`post${nested}`, depth + 1);
    }
    active.delete(name);
  };
  expand(`pre${scriptName}`, 0);
  expand(scriptName, 0);
  expand(`post${scriptName}`, 0);
  return commands;
}
