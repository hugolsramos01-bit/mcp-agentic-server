import { createRequire } from "node:module";
import { satisfies } from "semver";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as {
  engines?: {
    node?: string;
  };
};

export const SUPPORTED_NODE_RANGE =
  packageMetadata.engines?.node ?? ">=22.19.0 <27";

export function isSupportedNodeVersion(version: string): boolean {
  return satisfies(version, SUPPORTED_NODE_RANGE);
}
