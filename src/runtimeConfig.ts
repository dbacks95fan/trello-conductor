// ABOUTME: Locates the Orchestrator's runtime environment file outside project repositories.
import { resolve } from "node:path";

// ABOUTME: Keeps the Orchestrator's credentials separate from other agent runtimes.
export function defaultRuntimeSecretsFile(projectDirectory: string = process.cwd()): string {
  return resolve(projectDirectory, "..", ".config", "orchestrator", "runtime.env");
}
