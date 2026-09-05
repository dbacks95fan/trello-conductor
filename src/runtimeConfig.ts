// ABOUTME: Locates the workspace-level runtime environment file shared outside project repositories.
import { resolve } from "node:path";

// ABOUTME: Keeps credentials out of project repositories while allowing local services to share them.
export function defaultRuntimeSecretsFile(projectDirectory: string = process.cwd()): string {
  return resolve(projectDirectory, "..", ".config", "agentic-sdlc", "runtime.env");
}
