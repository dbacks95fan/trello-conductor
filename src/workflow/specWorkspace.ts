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
  /** HTTPS remote the clone's origin points at, shared with the container. */
  remoteUrl: string;
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
    created = true;
  } else {
    await git(["checkout", branch], path).catch(() => undefined);
  }

  // Cloning from the local path is fast and needs no credentials, but leaves an
  // origin the container cannot resolve. Retarget it at the real HTTPS remote so
  // git behaves the same inside the container as on the host, and so the branch
  // can be published for Design Review.
  // `git config --get` exits non-zero when the key is absent; treat that as "no
  // remote" so the explicit check below reports something actionable.
  const remoteUrl = await git(["config", "--get", "remote.origin.url"], input.targetRepo).catch(() => "");
  if (!remoteUrl.startsWith("https://")) {
    throw new Error(
      `TARGET_REPO remote.origin.url must be an HTTPS GitHub URL so the container and the push step can reach it; found "${remoteUrl || "none"}".`,
    );
  }
  const hasRemote = (await git(["remote"], path)).length > 0;
  await git(hasRemote ? ["remote", "set-url", "origin", remoteUrl] : ["remote", "add", "origin", remoteUrl], path);

  const relativeIntentPath = join(".agent", "work", input.intentId, "intent.md");
  await mkdir(join(path, ".agent", "work", input.intentId), { recursive: true });
  await writeFile(join(path, relativeIntentPath), input.frozenIntentBytes);

  // Plain add, never --force: a product repository must track `.agent/work/` so
  // agent-owned artifacts are ordinary versioned content. If this fails because
  // the path is ignored, the repository's .gitignore is wrong and should say so
  // loudly rather than be overridden here.
  await git(["add", "--", relativeIntentPath], path);
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
  return { path, branch, baseCommit, frozenArtifactSha256, remoteUrl, created };
}

/** Git credential configuration that resolves the token from the environment at
 *  call time, so the secret never appears in argv, in a config file, or in the
 *  reflog. The empty first value clears any inherited helper. Mirrors the
 *  configuration handed to the container. */
const CREDENTIAL_CONFIG = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f(){ echo username=x-access-token; echo "password=$GITHUB_TOKEN"; };f',
];

export interface PublishSpecBranchResult {
  pushed: boolean;
  branchUrl: string;
  reason?: string;
}

/** Publishes the work branch so a human Design Reviewer has something to open.
 *  The Conductor pushes, not the agent: AGENT_ROLES.md grants the Spec & Design
 *  Agent no write authority over the product repository, and the evaluator
 *  handoff already establishes the Conductor as the component that publishes a
 *  branch. Requires GITHUB_TOKEN in the orchestrator's environment. */
export async function publishSpecBranch(
  workspace: Pick<SpecWorkspace, "path" | "branch" | "remoteUrl">,
  token: string,
): Promise<PublishSpecBranchResult> {
  const branchUrl = `${workspace.remoteUrl.replace(/\.git$/, "")}/tree/${workspace.branch}`;
  if (!token) {
    return { pushed: false, branchUrl, reason: "GITHUB_TOKEN is not configured for the orchestrator." };
  }
  try {
    await execFileAsync("git", [...CREDENTIAL_CONFIG, "push", "--set-upstream", "origin", workspace.branch], {
      cwd: workspace.path,
      windowsHide: true,
      env: { ...process.env, GITHUB_TOKEN: token },
    });
    return { pushed: true, branchUrl };
  } catch (err) {
    return { pushed: false, branchUrl, reason: err instanceof Error ? err.message : String(err) };
  }
}
