import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseEnv } from "dotenv";
import { config } from "../config.js";

export interface CodingAgentResult {
  exitCode: number | null;
  stageResult: Record<string, unknown> | null;
  evidencePackage: Record<string, unknown> | null;
  rawOutput: string;
  diagnostics: Record<string, unknown> | null;
}

export interface CodingAgentRunOptions {
  cliPath?: string;
  runtimeEnvFile?: string | null;
}

export async function runCodingAgent(invocation: Record<string, unknown>, options: CodingAgentRunOptions = {}): Promise<CodingAgentResult> {
  const dir = await mkdtemp(join(tmpdir(), "trello-orchestrator-invocation-"));
  const invocationPath = join(dir, "stage-invocation.json");
  await writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`, "utf8");
  const runtimeEnvFile = options.runtimeEnvFile === undefined ? config.codingAgentRuntimeEnvFile : options.runtimeEnvFile;
  let agentEnv: NodeJS.ProcessEnv = {};
  try {
    if (runtimeEnvFile) agentEnv = parseEnv(await readFile(runtimeEnvFile, "utf8"));
    return await new Promise<CodingAgentResult>((resolvePromise) => {
      const child = spawn("node", [options.cliPath ?? config.codingAgentCli, "run", "--invocation", invocationPath], {
        env: { ...process.env, ...agentEnv },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += String(data)));
      child.stderr.on("data", (data) => (stderr += String(data)));
      child.on("error", (error) => resolvePromise({ exitCode: null, stageResult: null, evidencePackage: null, diagnostics: null, rawOutput: `${stdout}${stderr}${error.message}` }));
      child.on("close", (exitCode) => {
        try {
          const result = JSON.parse(stdout) as Record<string, unknown>;
          resolvePromise({
            exitCode,
            stageResult: result.stage_result && typeof result.stage_result === "object" ? result.stage_result as Record<string, unknown> : null,
            evidencePackage: result.evidence_package && typeof result.evidence_package === "object" ? result.evidence_package as Record<string, unknown> : null,
            diagnostics: result.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics as Record<string, unknown> : null,
            rawOutput: `${stdout}${stderr}`,
          });
        } catch {
          resolvePromise({ exitCode, stageResult: null, evidencePackage: null, diagnostics: null, rawOutput: `${stdout}${stderr}` });
        }
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
