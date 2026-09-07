// ABOUTME: End-to-end test of the orchestrator's Spec & Design pipeline minus the Trello REST calls.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpecRequest } from "../workflow/specRequestFromCard.js";
import { prepareSpecWorkspace } from "../workflow/specWorkspace.js";
import { routeSpecResult } from "../workflow/specRouting.js";
import { runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";
import type { TrelloCard } from "../trello/client.js";

const PATH = "products/mealflow/intents/INT-MF-0042/intent.md";

// Stand-in agent: verifies the frozen bytes against frozenArtifactSha256 (the
// real job's non-negotiable check), writes spec.md, commits it on the work
// branch, and prints one spec_ready result.
const AGENT_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const a = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(a[a.indexOf("--request") + 1], "utf8"));
const ws = request.target.workspace;
const intent = fs.readFileSync(path.join(ws, ".agent", "work", request.workItem, "intent.md"));
const sha = crypto.createHash("sha256").update(intent).digest("hex");
if (sha !== request.intent.frozenArtifactSha256) {
  process.stdout.write(JSON.stringify({ runId: request.runId, workItem: request.workItem, status: "blocked", summary: "INTENT_MUTATED", branch: request.target.branch, workspace: ws, intentCommit: request.intent.commit, frozenArtifactSha256: sha, intentContentSha256: request.intent.contentSha256, blockingConcerns: ["INTENT_MUTATED"], nonBlockingConcerns: [], humanDecisions: [] }));
  process.exit(20);
}
const specRelPath = path.join(".agent", "work", request.workItem, "spec.md");
fs.writeFileSync(path.join(ws, specRelPath), "# Requirements and Design Specification\\n\\n## Traceability to frozen intent\\n");
cp.execFileSync("git", ["add", "--force", "--", specRelPath], { cwd: ws });
cp.execFileSync("git", ["commit", "-m", "spec: INT-MF-0042"], { cwd: ws });
const specCommit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws }).toString().trim();
process.stdout.write(JSON.stringify({
  runId: request.runId, workItem: request.workItem, status: "spec_ready",
  summary: "Specification produced from the frozen intent.",
  branch: request.target.branch, workspace: ws, intentCommit: request.intent.commit,
  frozenArtifactSha256: request.intent.frozenArtifactSha256, intentContentSha256: request.intent.contentSha256,
  specCommit, specPath: specRelPath.replace(/\\\\/g, "/"), specVersion: 1,
  blockingConcerns: [], nonBlockingConcerns: [], humanDecisions: [],
}));
`;

function initTargetRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-e2e-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ".agent/\n");
  writeFileSync(join(dir, "app.js"), "// product code\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return dir;
}

const COMMIT = "a".repeat(40);
const HASH = "d".repeat(64);

function intentMarkdown(): string {
  return [
    "---",
    "intent_id: INT-MF-0042",
    "product_id: MF",
    "product_name: MealFlow",
    "trello_card_id: card-long-id",
    "intent_version: 3",
    "status: Frozen",
    `intent_commit: ${COMMIT}`,
    `intent_hash: sha256:${HASH}`,
    "frozen_at: 2026-08-01T12:00:00.000Z",
    "---",
    "",
    "# Intent: Weekly meal planner",
    "",
    "## Desired outcome",
    "A cook plans a week of meals in one sitting.",
  ].join("\n");
}

function card(): TrelloCard {
  return {
    id: "card-long-id",
    idShort: 42,
    name: "[Feature] Weekly meal planner",
    desc: [
      "Product: MealFlow (MF)",
      "Intent ID: INT-MF-0042",
      "Intent Version: 3",
      `Intent Commit: ${COMMIT}`,
      `Intent Hash: sha256:${HASH}`,
      "Intent Status: Frozen",
      `Canonical intent: https://github.com/dbacks95fan/intent-backlog/blob/${COMMIT}/${PATH}`,
    ].join("\n"),
    idList: "list-spec",
    shortLink: "abc123",
    url: "https://trello.com/c/abc123/42",
  };
}

test("card metadata + frozen intent -> worktree -> agent -> route to Design Review", async () => {
  const targetRepo = initTargetRepo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "spec-e2e-roots-"));
  const agentDir = mkdtempSync(join(tmpdir(), "spec-e2e-agent-"));
  const agentPath = join(agentDir, "agent.cjs");
  writeFileSync(agentPath, AGENT_SOURCE, "utf8");

  try {
    const markdown = intentMarkdown();
    const resolved = await resolveSpecRequest(card(), {
      githubApiBase: "https://api.github.com",
      githubToken: "",
      approvedBy: "Sobe",
      approvedAt: "2026-09-06T09:00:00.000Z",
      fetchFn: (async () => new Response(markdown)) as typeof fetch,
    });

    const workspace = await prepareSpecWorkspace({
      targetRepo,
      worktreeRoot,
      intentId: resolved.intentId,
      frozenIntentBytes: resolved.frozenIntentBytes,
    });

    const request: SpecDesignRequest = {
      runId: "e2e-run-1",
      workItem: resolved.intentId,
      productId: resolved.productId,
      intent: {
        repository: resolved.intentRepository,
        commit: resolved.intentCommit,
        path: resolved.intentPath,
        frozenArtifactSha256: workspace.frozenArtifactSha256,
        contentSha256: resolved.intentContentSha256,
      },
      target: { repository: targetRepo, baseCommit: workspace.baseCommit, branch: workspace.branch, workspace: workspace.path },
      approval: { readyForPlanning: true, approvedBy: resolved.approvedBy, approvedAt: resolved.approvedAt },
    };

    const run = await runSpecDesignAgent(request, { provider: "mock", command: ["node", agentPath] });
    assert.equal(run.result?.status, "spec_ready", run.rawStdout + run.rawStderr);

    const route = routeSpecResult(run);
    assert.equal(route.destination, "design-review");
    assert.match(route.comment, /\.agent\/work\/INT-MF-0042\/spec\.md/);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: workspace.path }).toString().trim().split("\n");
    assert.match(log[0], /spec: INT-MF-0042/);
    assert.match(log[1], /freeze intent for INT-MF-0042/);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.path }).toString().trim();
    assert.equal(branch, "work/INT-MF-0042");
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
