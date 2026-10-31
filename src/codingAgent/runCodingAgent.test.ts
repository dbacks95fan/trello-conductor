// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies the Orchestrator passes an accepted repository branch to the Coding Agent CLI.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodingAgent } from "./runCodingAgent.js";

test("passes a StageInvocation to the Coding Agent and parses its StageResult", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-coding-adapter-"));
  try {
    const cli = join(directory, "fake-coding-agent.cjs");
    writeFileSync(cli, "const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));process.stdout.write(JSON.stringify({stage_result:{schema_version:'1.0',invocation_id:input.invocation_id,stage:input.stage,status:'candidate_complete',work_item:input.work_item,output_artifacts:[],candidate:{repository:input.target.repository,commit_sha:'a'.repeat(40)}},evidence_package:{schema_version:'1.0'},diagnostics:{}}));\n", "utf8");
    const invocation = { invocation_id: "invocation-1", stage: "execution", work_item: { intent_id: "INT-MF-0042" }, target: { repository: "https://github.com/example/mealflow" } };
    const result = await runCodingAgent(invocation, { cliPath: cli, runtimeEnvFile: null });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stageResult?.invocation_id, "invocation-1");
    assert.equal(result.stageResult?.status, "candidate_complete");
    assert.ok(result.evidencePackage);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
