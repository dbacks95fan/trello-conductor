import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { config } from "../config.js";

export interface EvaluatorAgentResult {
  exitCode: number | null;
  evaluation: Record<string, unknown> | null;
  rawOutput: string;
}

export async function runEvaluatorAgent(
  contractText: string,
  evidence: Record<string, unknown>,
): Promise<EvaluatorAgentResult> {
  const workItem = String(evidence.workItem ?? "work-item");
  const worktree = evidence.worktree as { path?: string } | undefined;
  if (!worktree?.path) throw new Error("Coding Agent evidence does not include worktree.path");
  const intentPath = parse(contractText)?.intent?.path;
  if (typeof intentPath !== "string" || !intentPath) throw new Error("Work Contract does not contain a canonical intent path");
  const candidateIntentPath = join(worktree.path, intentPath);

  const dir = mkdtempSync(join(tmpdir(), "trello-conductor-evaluation-"));
  const contractPath = join(dir, `${workItem}.yaml`);
  const evidencePath = join(dir, `${workItem}-evidence.json`);
  writeFileSync(contractPath, contractText, "utf8");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");

  return new Promise((resolvePromise) => {
    const child = spawn(
      "node",
      [config.evaluatorAgentCli, "review", "--intent", candidateIntentPath, "--contract", contractPath, "--evidence", evidencePath, "--repo", worktree.path!],
      { env: process.env },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (exitCode) => {
      rmSync(dir, { recursive: true, force: true });
      let evaluation: Record<string, unknown> | null = null;
      try {
        evaluation = JSON.parse(stdout);
      } catch {
        // Keep raw output for human investigation.
      }
      resolvePromise({ exitCode, evaluation, rawOutput: stdout + stderr });
    });
  });
}
