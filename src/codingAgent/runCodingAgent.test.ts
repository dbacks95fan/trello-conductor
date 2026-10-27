// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies the Conductor passes an accepted repository branch to the Coding Agent CLI.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkContract } from "../workflow/contractFromCard.js";
import { runCodingAgent } from "./runCodingAgent.js";

test("runs the Coding Agent against the accepted repository and base branch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "conductor-coding-adapter-"));
  try {
    const cli = join(directory, "fake-coding-agent.cjs");
    writeFileSync(cli, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));\n", "utf8");
    const contract: WorkContract = {
      schema_version: 2,
      work_item: "INT-MF-0042-v3",
      objective: "Plan meals weekly.",
      acceptance_criteria: { AC1: "Save a weekly plan." },
      required_validation: ["build"],
      intent: { path: ".agent/work/INT-MF-0042/intent.md", revision: "a".repeat(40), sha256: "b".repeat(64), reviewUrl: "https://github.com/example/mealflow/blob/main/spec.md", status: "Accepted", acceptedBy: "owner-1", acceptedAt: "2026-10-27T12:00:00Z" },
      board: { provider: "trello", workItemId: "card-1", workItemUrl: "https://trello.com/c/abc", workItemType: "Feature" },
    };
    const repoRoot = join(directory, "product-repo");
    const result = await runCodingAgent(contract, { repoRoot, baseBranch: "work/INT-MF-0042", cliPath: cli });
    assert.equal(result.exitCode, 0);
    const output = result.evidence as { args: string[] };
    assert.deepEqual(output.args.slice(0, 2), ["run", "--contract"]);
    assert.deepEqual(output.args.slice(-4), ["--repo", repoRoot, "--base-branch", "work/INT-MF-0042"]);
    assert.ok(result.contractText.includes("schema_version: 2"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
