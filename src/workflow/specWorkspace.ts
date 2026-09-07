// ABOUTME: Creates the isolated work/<intent-id> worktree and freezes intent.md into it for the Spec & Design Agent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Run Git without a shell so an intent id can never alter the command structure.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export interface PrepareSpecWorkspaceInput {
  targetRepo: string;
  worktreeRoot: string;
  intentId: string;
  frozenIntentBytes: Buffer;
}

export interface SpecWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
  frozenArtifactSha256: string;
  created: boolean;
}

/** Idempotent: an existing work/<intent-id> worktree is reused so re-entering
 *  Spec & Design does not fail on `git worktree add`. The frozen intent.md is
 *  (re)written and committed on the work branch; the Spec & Design Agent then
 *  re-verifies its raw bytes against frozenArtifactSha256 before doing anything. */
export async function prepareSpecWorkspace(input: PrepareSpecWorkspaceInput): Promise<SpecWorkspace> {
  const branch = `work/${input.intentId}`;
  const path = resolve(input.worktreeRoot, input.intentId);
  const baseCommit = await git(["rev-parse", "HEAD"], input.targetRepo);

  const worktrees = await git(["worktree", "list", "--porcelain"], input.targetRepo);
  const known = worktrees
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()));
  let created = false;
  if (!known.includes(path)) {
    await mkdir(input.worktreeRoot, { recursive: true });
    const branchExists = (await git(["branch", "--list", branch], input.targetRepo)).trim().length > 0;
    const addArgs = branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, baseCommit];
    await git(addArgs, input.targetRepo);
    created = true;
  }

  const relativeIntentPath = join(".agent", "work", input.intentId, "intent.md");
  await mkdir(join(path, ".agent", "work", input.intentId), { recursive: true });
  await writeFile(join(path, relativeIntentPath), input.frozenIntentBytes);

  // .agent/ is commonly gitignored in product repos; force-add so the frozen
  // input is committed on the work branch as its chain-of-custody root.
  await git(["add", "--force", "--", relativeIntentPath], path);
  const staged = await git(["diff", "--cached", "--name-only"], path);
  if (staged) {
    await git(["commit", "-m", `chore(agent): freeze intent for ${input.intentId}`], path);
  }

  const frozenArtifactSha256 = createHash("sha256").update(input.frozenIntentBytes).digest("hex");
  return { path, branch, baseCommit, frozenArtifactSha256, created };
}
