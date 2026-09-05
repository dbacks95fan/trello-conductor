// ABOUTME: Commits and pushes immutable evaluator artifacts to the candidate branch.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitEvaluationHandoffInput {
  workItem: string;
  worktreePath: string;
  branch: string;
  intentPath: string;
  contractText: string;
  evidencePath: string;
}

export interface GitEvaluationHandoff {
  repositoryUrl: string;
  revision: string;
  intentPath: string;
  contractPath: string;
  evidencePath: string;
}

// ABOUTME: Runs Git without a shell so work-item data cannot alter the command structure.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

// ABOUTME: Ensures a path remains a portable repository-relative artifact reference.
function repositoryPath(path: string): string {
  if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error("Evaluator artifact paths must be repository-relative and may not escape the candidate branch");
  }
  return path.replaceAll("\\", "/");
}

// ABOUTME: Stores the exact evaluation inputs with the candidate so a remote evaluator can reproduce the run.
export async function prepareGitEvaluationHandoff(input: GitEvaluationHandoffInput): Promise<GitEvaluationHandoff> {
  const intentPath = repositoryPath(input.intentPath);
  const status = await git(["status", "--porcelain", "--untracked-files=all"], input.worktreePath);
  if (status) throw new Error("Candidate branch has uncommitted changes. The evaluator requires a clean, committed Git revision.");

  const contractPath = `.agent/work/${input.workItem}/contract.yaml`;
  const evidencePath = `.agent/evidence/${input.workItem}-${input.evidencePath}`;
  const evidenceSource = resolve(input.evidencePath);
  const worktree = resolve(input.worktreePath);
  if (!relative(worktree, evidenceSource)) throw new Error("Evaluator evidence must be stored outside the candidate worktree before it is copied into the branch");

  await mkdir(join(worktree, ".agent", "work", input.workItem), { recursive: true });
  await mkdir(join(worktree, ".agent", "evidence"), { recursive: true });
  const evidence = await (await import("node:fs/promises")).readFile(evidenceSource, "utf8");
  await writeFile(join(worktree, contractPath), input.contractText, "utf8");
  await writeFile(join(worktree, evidencePath), evidence, "utf8");
  await git(["add", "--force", contractPath, evidencePath], worktree);
  await git(["commit", "-m", `chore(agent): record evaluation handoff for ${input.workItem}`], worktree);

  const revision = await git(["rev-parse", "HEAD"], worktree);
  const repositoryUrl = await git(["config", "--get", "remote.origin.url"], worktree);
  if (!repositoryUrl.startsWith("https://")) throw new Error("Candidate remote.origin.url must use HTTPS so the NAS evaluator can retrieve the committed revision");
  await git(["push", "--set-upstream", "origin", input.branch], worktree);
  return { repositoryUrl, revision, intentPath, contractPath, evidencePath };
}
