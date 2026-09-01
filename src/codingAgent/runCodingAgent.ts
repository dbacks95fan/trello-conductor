import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { config } from "../config.js";
import type { WorkContract } from "../workflow/contractFromCard.js";

export interface CodingAgentResult {
  exitCode: number | null;
  evidence: Record<string, unknown> | null;
  rawOutput: string;
  contractText: string;
}

export async function runCodingAgent(contract: WorkContract): Promise<CodingAgentResult> {
  const dir = mkdtempSync(join(tmpdir(), "trello-conductor-contract-"));
  const contractPath = join(dir, `${contract.work_item}.yaml`);
  const contractText = stringify(contract);
  writeFileSync(contractPath, contractText, "utf8");

  return new Promise((resolvePromise) => {
    const child = spawn(
      "node",
      [config.codingAgentCli, "run", "--contract", contractPath, "--repo", config.targetRepo],
      { env: process.env },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (exitCode) => {
      rmSync(dir, { recursive: true, force: true });
      let evidence: Record<string, unknown> | null = null;
      try {
        evidence = JSON.parse(stdout);
      } catch {
        // stdout wasn't valid JSON — evidence stays null, rawOutput still returned for logging
      }
      resolvePromise({ exitCode, evidence, rawOutput: stdout + stderr, contractText });
    });
  });
}
