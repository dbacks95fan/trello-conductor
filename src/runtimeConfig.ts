// ABOUTME: Locates the user-level runtime environment file shared outside project repositories.
import { homedir } from "node:os";
import { join } from "node:path";

// ABOUTME: Keeps credentials out of project repositories while allowing local services to share them.
export function defaultRuntimeSecretsFile(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".config", "agentic-sdlc", "runtime.env");
}
