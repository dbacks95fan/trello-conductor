// ABOUTME: Spawns the Spec & Design Agent as a bounded local subprocess and captures its one JSON result.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

/** The bounded request the Spec & Design Agent consumes on stdin-adjacent file
 *  input. Shape mirrors spec-design-agent/schemas/spec-request.schema.json. */
export interface SpecDesignRequest {
  runId: string;
  workItem: string;
  productId: string;
  intent: {
    repository: string;
    commit: string;
    path: string;
    frozenArtifactSha256: string;
    contentSha256: string;
  };
  target: {
    repository: string;
    baseCommit: string;
    branch: string;
    workspace: string;
  };
  approval: {
    readyForPlanning: boolean;
    approvedBy: string;
    approvedAt: string;
  };
}

export interface SpecDesignResult {
  exitCode: number | null;
  result: Record<string, unknown> | null;
  rawStdout: string;
  rawStderr: string;
}

/** Splits a configured command into argv. A leading `[` is treated as a JSON
 *  array so commands with awkward spacing can be given exactly; otherwise the
 *  string is split on whitespace. */
export function parseAgentCommand(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string") || parsed.length === 0) {
      throw new Error("SPEC_DESIGN_AGENT_CLI JSON must be a non-empty array of strings");
    }
    return parsed as string[];
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("SPEC_DESIGN_AGENT_CLI is empty");
  return parts;
}

export interface RunSpecDesignAgentOptions {
  command?: string[];
  provider?: string;
}

export async function runSpecDesignAgent(
  request: SpecDesignRequest,
  options: RunSpecDesignAgentOptions = {},
): Promise<SpecDesignResult> {
  const command = options.command ?? parseAgentCommand(config.specDesignAgentCli);
  const provider = options.provider ?? config.specDesignAgentProvider;

  const dir = mkdtempSync(join(tmpdir(), "trello-conductor-spec-request-"));
  const requestPath = join(dir, `${request.workItem}.json`);
  writeFileSync(requestPath, JSON.stringify(request, null, 2), "utf8");

  const [exe, ...prefix] = command;
  return new Promise((resolvePromise) => {
    const child = spawn(exe, [...prefix, "spec", "--request", requestPath, "--provider", provider], {
      env: { ...process.env, SPEC_AGENT_PROVIDER: provider },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ exitCode: null, result: null, rawStdout: stdout, rawStderr: `${stderr}\n${String(err)}` });
    });

    child.on("close", (exitCode) => {
      rmSync(dir, { recursive: true, force: true });
      let result: Record<string, unknown> | null = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            result = parsed as Record<string, unknown>;
          }
        } catch {
          // stdout was not the single JSON result document — result stays null,
          // raw streams are still returned so the workflow can quote them.
        }
      }
      resolvePromise({ exitCode, result, rawStdout: stdout, rawStderr: stderr });
    });
  });
}
