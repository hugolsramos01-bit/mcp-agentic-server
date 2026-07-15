import { basename } from "node:path";
import { AccessDeniedError } from "../roots.js";

// A list of highly sensitive patterns that should NEVER be accessed 
// (unless explicitly whitelisted by exceptions)
const SECRET_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /^credentials\.json$/,
  /^service-account.*\.json$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /^id_rsa$/,
  /^id_dsa$/,
  /^id_ecdsa$/,
  /^id_ed25519$/
];

const SECRET_EXCEPTIONS = [
  /^\.env\.example$/,
  /^\.env\.sample$/,
  /^\.env\.template$/
];

export function isSecretFile(path: string): boolean {
  const fileName = basename(path).toLowerCase();

  const isException = SECRET_EXCEPTIONS.some(pattern => pattern.test(fileName));
  if (isException) return false;

  return SECRET_PATTERNS.some(pattern => pattern.test(fileName));
}

export function assertPathOperationAllowed(
  path: string, 
  operation: "read" | "write" | "search" | "execute"
): void {
  // Currently, we universally block secrets for all operations
  // Future enhancements can separate read vs write policies.
  if (isSecretFile(path)) {
    throw new AccessDeniedError(`Security Policy Violation: Access to secret file denied for operation '${operation}' on ${path}`);
  }
}
