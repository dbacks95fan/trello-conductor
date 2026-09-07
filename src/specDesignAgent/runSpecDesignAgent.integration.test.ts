// ABOUTME: Verifies the Spec & Design Agent handoff across a real spawned process and request file.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";

// A stand-in agent as an on-disk script: it consumes the request file the
// orchestrator writes, drops a spec.md into the supplied workspace, and prints
// one result document — the same contract the real Python job honours.
const AGENT_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] !== "spec") { console.error("expected 'spec' subcommand"); process.exit(2); }
const request = JSON.parse(fs.readFileSync(args[args.indexOf("--request") + 1], "utf8"));
const provider = args[args.indexOf("--provider") + 1];
const specPath = path.join(".agent", "work", request.workItem, "spec.md");
fs.mkdirSync(path.join(request.target.workspace, path.dirname(specPath)), { recursive: true });
fs.writeFileSync(path.join(request.target.workspace, specPath), "# Requirements and Design Specification\\n");
process.stderr.write(JSON.stringify({ level: "info", provider, runId: request.runId }) + "\\n");
process.stdout.write(JSON.stringify({
  runId: request.runId,
  workItem: request.workItem,
  status: "spec_ready",
  summary: "Specification produced from the frozen intent.",
  branch: request.target.branch,
  workspace: request.target.workspace,
  intentCommit: request.intent.commit,
  frozenArtifactSha256: request.intent.frozenArtifactSha256,
  intentContentSha256: request.intent.contentSha256,
  specCommit: "f".repeat(40),
  specPath,
  specVersion: 1,
  blockingConcerns: [],
  nonBlockingConcerns: [],
  humanDecisions: [],
}));
`;

test("round-trips the request file to a spawned agent and back to a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-agent-integration-"));
  const agentPath = join(dir, "fake-agent.cjs");
  const workspace = join(dir, "workspace");
  writeFileSync(agentPath, AGENT_SOURCE, "utf8");

  const request: SpecDesignRequest = {
    runId: "run-integration-1",
    workItem: "INT-MF-0042",
    productId: "MF",
    intent: {
      repository: "dbacks95fan/intent-backlog",
      commit: "a".repeat(40),
      path: "products/mealflow/intents/INT-MF-0042/intent.md",
      frozenArtifactSha256: "b".repeat(64),
      contentSha256: "c".repeat(64),
    },
    target: { repository: dir, baseCommit: "d".repeat(40), branch: "work/INT-MF-0042", workspace },
    approval: { readyForPlanning: true, approvedBy: "Sobe", approvedAt: "2026-09-06T09:00:00.000Z" },
  };

  try {
    const run = await runSpecDesignAgent(request, { provider: "mock", command: ["node", agentPath] });
    assert.equal(run.exitCode, 0);
    assert.equal(run.result?.status, "spec_ready");
    assert.equal(String(run.result?.specPath).replace(/\\/g, "/"), ".agent/work/INT-MF-0042/spec.md");
    assert.match(run.rawStderr, /"provider":"mock"/);
    assert.equal(
      readFileSync(join(workspace, ".agent", "work", "INT-MF-0042", "spec.md"), "utf8"),
      "# Requirements and Design Specification\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
