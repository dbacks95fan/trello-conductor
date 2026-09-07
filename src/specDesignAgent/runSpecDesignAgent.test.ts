// ABOUTME: Unit tests for spawning the Spec & Design Agent subprocess and parsing its result.
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentCommand, runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";

const request: SpecDesignRequest = {
  runId: "run-1",
  workItem: "INT-MF-0042",
  productId: "MF",
  intent: {
    repository: "dbacks95fan/intent-backlog",
    commit: "a".repeat(40),
    path: "products/mealflow/intents/INT-MF-0042/intent.md",
    frozenArtifactSha256: "b".repeat(64),
    contentSha256: "c".repeat(64),
  },
  target: { repository: "C:/Repos/menuapp", baseCommit: "d".repeat(40), branch: "work/INT-MF-0042", workspace: "/tmp/ws" },
  approval: { readyForPlanning: true, approvedBy: "Sobe", approvedAt: "2026-09-06T09:00:00.000Z" },
};

// A stand-in agent: echoes a chosen result JSON on stdout, a log on stderr, and
// exits with a chosen code. Receives ["spec", "--request", <file>, "--provider", <p>].
function fakeAgent(resultJson: string, exitCode: number): string[] {
  const script = `
    const fs = require("node:fs");
    const i = process.argv.indexOf("--request");
    const req = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
    process.stderr.write(JSON.stringify({ level: "info", msg: "started", runId: req.runId }) + "\\n");
    process.stdout.write(${JSON.stringify(resultJson)}.replace("__RUN__", req.runId));
    process.exit(${exitCode});
  `;
  return ["node", "-e", script];
}

test("parseAgentCommand splits a plain string and parses a JSON array", () => {
  assert.deepEqual(parseAgentCommand("uv run spec-design-agent"), ["uv", "run", "spec-design-agent"]);
  assert.deepEqual(parseAgentCommand('["uv","run","--project","C:/x y","spec-design-agent"]'), [
    "uv",
    "run",
    "--project",
    "C:/x y",
    "spec-design-agent",
  ]);
  assert.throws(() => parseAgentCommand("   "));
  assert.throws(() => parseAgentCommand("[]"));
  assert.throws(() => parseAgentCommand('["uv", 3]'));
});

test("runSpecDesignAgent parses the single JSON result document from stdout", async () => {
  const run = await runSpecDesignAgent(request, {
    provider: "mock",
    command: fakeAgent('{"runId":"__RUN__","workItem":"INT-MF-0042","status":"spec_ready","summary":"ok"}', 0),
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result?.status, "spec_ready");
  assert.equal(run.result?.runId, "run-1");
  assert.match(run.rawStderr, /started/);
});

test("runSpecDesignAgent keeps the raw streams when stdout is not JSON", async () => {
  const run = await runSpecDesignAgent(request, { provider: "mock", command: fakeAgent("agent crashed before writing a result", 1) });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result, null);
  assert.match(run.rawStdout, /agent crashed/);
});

test("runSpecDesignAgent propagates a non-zero exit alongside a parsed result", async () => {
  const run = await runSpecDesignAgent(request, {
    provider: "mock",
    command: fakeAgent('{"status":"blocked","summary":"precondition failed","blockingConcerns":["INTENT_MUTATED"]}', 20),
  });
  assert.equal(run.exitCode, 20);
  assert.equal(run.result?.status, "blocked");
});

test("runSpecDesignAgent reports a spawn failure instead of throwing", async () => {
  const run = await runSpecDesignAgent(request, { provider: "mock", command: ["this-binary-does-not-exist-9f3a"] });
  assert.equal(run.exitCode, null);
  assert.equal(run.result, null);
  assert.match(run.rawStderr, /ENOENT|spawn/i);
});
