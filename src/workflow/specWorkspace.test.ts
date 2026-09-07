// ABOUTME: Tests that the Spec & Design worktree is created, freezes intent.md, and is idempotent.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSpecWorkspace } from "./specWorkspace.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-workspace-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ".agent/\n");
  writeFileSync(join(dir, "README.md"), "target repo\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return dir;
}

test("prepareSpecWorkspace creates work/<id>, freezes intent.md, and is idempotent", async () => {
  const targetRepo = initRepo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  const frozenIntentBytes = Buffer.from("---\nintent_id: INT-MF-0042\nstatus: Frozen\n---\n\n# Intent\n");
  const intentId = "INT-MF-0042";

  try {
    const first = await prepareSpecWorkspace({ targetRepo, worktreeRoot, intentId, frozenIntentBytes });

    assert.equal(first.created, true);
    assert.equal(first.branch, "work/INT-MF-0042");
    assert.match(first.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(first.frozenArtifactSha256, createHash("sha256").update(frozenIntentBytes).digest("hex"));

    const intentFile = join(first.path, ".agent", "work", intentId, "intent.md");
    assert.ok(existsSync(intentFile));
    assert.deepEqual(readFileSync(intentFile), frozenIntentBytes);

    const branchInWorktree = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: first.path }).toString().trim();
    assert.equal(branchInWorktree, "work/INT-MF-0042");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: first.path }).toString().trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /freeze intent for INT-MF-0042/);

    const second = await prepareSpecWorkspace({ targetRepo, worktreeRoot, intentId, frozenIntentBytes });
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    const logAfter = execFileSync("git", ["log", "--oneline"], { cwd: first.path }).toString().trim().split("\n");
    assert.equal(logAfter.length, 2, "re-entering Spec & Design must not add another freeze commit");
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});
