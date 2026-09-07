// ABOUTME: Creates a self-contained work/<intent-id> clone of the target repo and freezes intent.md into it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Run Git without a shell so an intent id can never alter the command structure.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export interface PrepareSpecWorkspaceInput {
  targetRepo: string;
  workspaceRoot: string;
  intentId: string;
  frozenIntentBytes: Buffer;
}

export interface SpecWorkspace {
  /** Absolute host path of the clone; bind-mounted into the container at /work. */
  path: string;
  branch: string;
  baseCommit: string;
  frozenArtifactSha256: string;
  created: boolean;
}

/** A full local clone rather than a `git worktree`: the Spec & Design Agent runs
 *  inside a container and needs a self-contained `.git` directory, which a
 *  worktree's `.git` link file (an absolute host path) cannot provide. The clone
 *  carries all history so the agent can verify `baseCommit`. Idempotent: an
 *  existing clone is reused so re-entering Spec & Design does not re-clone. */
export async function prepareSpecWorkspace(input: PrepareSpecWorkspaceInput): Promise<SpecWorkspace> {
  const branch = `work/${input.intentId}`;
  const path = resolve(input.workspaceRoot, input.intentId);
  const baseCommit = await git(["rev-parse", "HEAD"], input.targetRepo);

  let created = false;
  if (!existsSync(join(path, ".git"))) {
    await mkdir(input.workspaceRoot, { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(["clone", "--no-hardlinks", input.targetRepo, path], input.workspaceRoot);
    const hasBranch = (await git(["branch", "--list", branch], path)).length > 0;
    await git(hasBranch ? ["checkout", branch] : ["checkout", "-b", branch, baseCommit], path);
    // The clone's origin is a host path the container cannot reach; the agent
    // works offline against local history, so drop it to avoid confusing fetches.
    await git(["remote", "remove", "origin"], path).catch(() => undefined);
    created = true;
  } else {
    await git(["checkout", branch], path).catch(() => undefined);
  }

  const relativeIntentPath = join(".agent", "work", input.intentId, "intent.md");
  await mkdir(join(path, ".agent", "work", input.intentId), { recursive: true });
  await writeFile(join(path, relativeIntentPath), input.frozenIntentBytes);

  // .agent/ is commonly gitignored in product repos; force-add so the frozen
  // input is committed on the work branch as its chain-of-custody root.
  await git(["add", "--force", "--", relativeIntentPath], path);
  if ((await git(["diff", "--cached", "--name-only"], path)).length > 0) {
    await git(
      [
        "-c",
        "user.email=conductor@agentic-sdlc.local",
        "-c",
        "user.name=Trello Conductor",
        "commit",
        "-m",
        `chore(agent): freeze intent for ${input.intentId}`,
      ],
      path,
    );
  }

  const frozenArtifactSha256 = createHash("sha256").update(input.frozenIntentBytes).digest("hex");
  return { path, branch, baseCommit, frozenArtifactSha256, created };
}
