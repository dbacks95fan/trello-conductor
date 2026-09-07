// ABOUTME: Verifies the Spec & Design Agent container handoff across a real spawned docker CLI process.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER = join(here, "__fixtures__", "fake-docker.cjs");

const FROZEN_INTENT = Buffer.from("---\nintent_id: INT-MF-0042\nstatus: Frozen\n---\n\n# Intent\n");

function workspaceWithIntent(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-container-ws-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "work/INT-MF-0042");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "app.js"), "// product code\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  mkdirSync(join(dir, ".agent", "work", "INT-MF-0042"), { recursive: true });
  writeFileSync(join(dir, ".agent", "work", "INT-MF-0042", "intent.md"), FROZEN_INTENT);
  return { dir, sha: createHash("sha256").update(FROZEN_INTENT).digest("hex") };
}

function request(workspaceSha: string): SpecDesignRequest {
  return {
    runId: "run-integration-1",
    workItem: "INT-MF-0042",
    productId: "MF",
    intent: {
      repository: "dbacks95fan/intent-backlog",
      commit: "a".repeat(40),
      path: "products/mealflow/intents/INT-MF-0042/intent.md",
      frozenArtifactSha256: workspaceSha,
      contentSha256: "c".repeat(64),
    },
    target: { repository: "C:/Repos/menuapp", baseCommit: "d".repeat(40), branch: "work/INT-MF-0042", workspace: "/work" },
    approval: { readyForPlanning: true, approvedBy: "Sobe", approvedAt: "2026-09-06T09:00:00.000Z" },
  };
}

test("writes the request into the mount, runs the container, and parses the result", async () => {
  const { dir, sha } = workspaceWithIntent();
  const argvLog = join(mkdtempSync(join(tmpdir(), "spec-container-log-")), "argv.json");
  process.env.FAKE_DOCKER_ARGV_LOG = argvLog;
  process.env.FAKE_DOCKER_MODE = "spec_ready";

  try {
    const run = await runSpecDesignAgent(request(sha), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      image: "spec-design-agent:local",
      provider: "mock",
      envFile: null,
    });

    assert.equal(run.exitCode, 0, run.rawStdout + run.rawStderr);
    assert.equal(run.result?.status, "spec_ready");
    assert.equal(run.result?.specPath, ".agent/work/INT-MF-0042/spec.md");
    assert.match(String(run.result?.specCommit), /^[0-9a-f]{40}$/);

    // The agent saw the request through the bind mount, not a host path.
    const argv = JSON.parse(readFileSync(argvLog, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--request") + 1], "/work/spec-design-request.json");
    assert.equal(argv[argv.indexOf("--mount") + 1], `type=bind,source=${dir},target=/work`);
    assert.ok(argv.includes("SPEC_AGENT_PROVIDER=mock"));

    // The spec is committed on the work branch inside the mounted workspace.
    assert.ok(existsSync(join(dir, ".agent", "work", "INT-MF-0042", "spec.md")));
    // The transient request file is cleaned up afterwards.
    assert.ok(!existsSync(join(dir, "spec-design-request.json")));
  } finally {
    delete process.env.FAKE_DOCKER_ARGV_LOG;
    delete process.env.FAKE_DOCKER_MODE;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(argvLog), { recursive: true, force: true });
  }
});

test("surfaces a container crash as an unparseable result", async () => {
  const { dir, sha } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "garbage";
  try {
    const run = await runSpecDesignAgent(request(sha), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.exitCode, 30);
    assert.equal(run.result, null);
    assert.match(run.rawStderr, /provider exploded/);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports a mutated frozen intent as blocked", async () => {
  const { dir } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "spec_ready";
  try {
    const run = await runSpecDesignAgent(request("f".repeat(64)), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.result?.status, "blocked");
    assert.deepEqual(run.result?.blockingConcerns, ["INTENT_MUTATED"]);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kills the container and reports a timeout when it overruns its budget", async () => {
  const { dir, sha } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "hang";
  try {
    const run = await runSpecDesignAgent(request(sha), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
      timeoutMs: 300,
    });
    assert.equal(run.timedOut, true);
    assert.equal(run.result, null);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports a missing docker binary instead of throwing", async () => {
  const { dir, sha } = workspaceWithIntent();
  try {
    const run = await runSpecDesignAgent(request(sha), {
      hostWorkspace: dir,
      docker: ["this-docker-does-not-exist-9f3a"],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.result, null);
    assert.equal(run.timedOut, false);
    assert.match(run.rawStderr, /ENOENT|spawn/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
