import { createRequire } from "node:module";

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
};

export function getRuntimeVersion(): string {
  const require = createRequire(import.meta.url);
  const metadata = require("../../../package.json") as PackageMetadata;
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Runtime package version is unavailable.");
  }
  return metadata.version;
}

export async function runVersionCommand(): Promise<void> {
  console.log(getRuntimeVersion());
}
