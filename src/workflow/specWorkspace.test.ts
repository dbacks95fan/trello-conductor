// ABOUTME: Tests that the Spec & Design workspace is a self-contained clone with the frozen intent committed.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSpecWorkspace, publishSpecBranch } from "./specWorkspace.js";

const REMOTE_URL = "https://github.com/example/target.git";

function initRepo(originUrl: string | null = REMOTE_URL): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-workspace-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // A compliant product repo: agent scratch is ignored, `.agent/work/` is tracked
  // so every stage can commit its artifacts with a plain `git add`.
  writeFileSync(join(dir, ".gitignore"), ".agent/*\n!.agent/work/\n");
  writeFileSync(join(dir, "README.md"), "target repo\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  // Never contacted: the clone is made from the local path, and origin is only
  // retargeted so the container and the push step have a reachable remote.
  if (originUrl) git("remote", "add", "origin", originUrl);
  return dir;
}

test("prepareSpecWorkspace clones work/<id>, freezes intent.md, and is idempotent", async () => {
  const targetRepo = initRepo();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  const frozenIntentBytes = Buffer.from("---\nintent_id: INT-MF-0042\nstatus: Frozen\n---\n\n# Intent\n");
  const intentId = "INT-MF-0042";

  try {
    const first = await prepareSpecWorkspace({ targetRepo, workspaceRoot, intentId, frozenIntentBytes });

    assert.equal(first.created, true);
    assert.equal(first.branch, "work/INT-MF-0042");
    assert.match(first.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(first.frozenArtifactSha256, createHash("sha256").update(frozenIntentBytes).digest("hex"));

    // A container needs a real .git directory, not a worktree link file.
    assert.ok(statSync(join(first.path, ".git")).isDirectory(), ".git must be a directory so git works inside the container");

    const intentFile = join(first.path, ".agent", "work", intentId, "intent.md");
    assert.ok(existsSync(intentFile));
    assert.deepEqual(readFileSync(intentFile), frozenIntentBytes);

    const git = (...args: string[]) => execFileSync("git", args, { cwd: first.path }).toString().trim();
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "work/INT-MF-0042");
    // The base commit is reachable so the agent can verify it offline.
    assert.equal(git("rev-parse", `${first.baseCommit}^{commit}`), first.baseCommit);
    // origin is retargeted from the unreachable host path to the real HTTPS
    // remote, so git behaves the same inside the container as on the host.
    assert.equal(git("remote"), "origin");
    assert.equal(git("config", "--get", "remote.origin.url"), REMOTE_URL);
    assert.equal(first.remoteUrl, REMOTE_URL);

    const log = git("log", "--oneline").split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /freeze intent for INT-MF-0042/);

    const second = await prepareSpecWorkspace({ targetRepo, workspaceRoot, intentId, frozenIntentBytes });
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    assert.equal(
      execFileSync("git", ["log", "--oneline"], { cwd: first.path }).toString().trim().split("\n").length,
      2,
      "re-entering Spec & Design must not add another freeze commit",
    );
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareSpecWorkspace fails loudly when the repo ignores .agent/work/", async () => {
  const targetRepo = initRepo();
  // A non-compliant product repo: the artifact home is ignored. We never work
  // around this with --force; the repository's .gitignore is the thing to fix.
  writeFileSync(join(targetRepo, ".gitignore"), ".agent/\n");
  execFileSync("git", ["commit", "-qam", "ignore .agent"], { cwd: targetRepo, stdio: "pipe" });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  try {
    await assert.rejects(
      prepareSpecWorkspace({
        targetRepo,
        workspaceRoot,
        intentId: "INT-MF-0042",
        frozenIntentBytes: Buffer.from("---\nintent_id: INT-MF-0042\n---\n"),
      }),
    );
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareSpecWorkspace refuses a target repo without an HTTPS remote", async () => {
  const targetRepo = initRepo(null);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  try {
    await assert.rejects(
      prepareSpecWorkspace({
        targetRepo,
        workspaceRoot,
        intentId: "INT-MF-0042",
        frozenIntentBytes: Buffer.from("x"),
      }),
      /must be an HTTPS GitHub URL/,
    );
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("publishSpecBranch pushes the work branch and reports its URL", async () => {
  const bare = mkdtempSync(join(tmpdir(), "spec-remote-"));
  const clone = mkdtempSync(join(tmpdir(), "spec-clone-"));
  try {
    execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", bare, join(clone, "w")], { stdio: "pipe" });
    const work = join(clone, "w");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("checkout", "-qb", "work/INT-MF-0042");
    writeFileSync(join(work, "spec.md"), "spec\n");
    git("add", "-A");
    git("commit", "-qm", "spec");

    const result = await publishSpecBranch(
      { path: work, branch: "work/INT-MF-0042", remoteUrl: "https://github.com/example/target.git" },
      "test-token",
    );

    assert.equal(result.pushed, true, String(result.reason ?? ""));
    assert.equal(result.branchUrl, "https://github.com/example/target/tree/work/INT-MF-0042");
    // The branch really landed on the remote.
    assert.match(
      execFileSync("git", ["--git-dir", bare, "branch", "--list", "work/INT-MF-0042"]).toString(),
      /work\/INT-MF-0042/,
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("publishSpecBranch reports rather than throws when no token is configured", async () => {
  const result = await publishSpecBranch(
    { path: tmpdir(), branch: "work/INT-MF-0042", remoteUrl: "https://github.com/example/target.git" },
    "",
  );
  assert.equal(result.pushed, false);
  assert.match(String(result.reason), /GITHUB_TOKEN/);
  assert.equal(result.branchUrl, "https://github.com/example/target/tree/work/INT-MF-0042");
});
