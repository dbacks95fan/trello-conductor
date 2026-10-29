// ABOUTME: Loads repository configuration and user-level agent credentials for the orchestrator.
import dotenv from "dotenv";
import { resolve } from "node:path";
import { defaultRuntimeSecretsFile } from "./runtimeConfig.js";

dotenv.config({ path: process.env.ORCHESTRATOR_SECRETS_FILE ?? defaultRuntimeSecretsFile() });
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const targetRepo = required("TARGET_REPO");

export const config = {
  trelloApiKey: required("TRELLO_API_KEY"),
  trelloToken: required("TRELLO_TOKEN"),
  trelloApiSecret: required("TRELLO_API_SECRET"),
  boardId: required("TRELLO_BOARD_ID"),
  boardWorkflowTemplate:
    process.env.TRELLO_WORKFLOW_TEMPLATE ?? resolve(targetRepo, "..", "agentic-sdlc", "templates", "trello-board-workflow.yaml"),
  lifecycleSchemaPath:
    process.env.AGENTIC_SDLC_SCHEMA_PATH ?? resolve(targetRepo, "..", "agentic-sdlc", "schemas", "lifecycle-contracts.schema.json"),
  wipLimit: Number(process.env.WIP_LIMIT ?? "1"),
  codingAgentCli: required("CODING_AGENT_CLI"),
  // The Spec & Design Agent runs as a one-shot Docker container on this host.
  // The image is built and deployed separately (spec-design-agent/compose.yaml);
  // the orchestrator only invokes `docker run` against it.
  specDesignDockerBin: process.env.SPEC_DESIGN_AGENT_DOCKER ?? "docker",
  specDesignImage: process.env.SPEC_DESIGN_AGENT_IMAGE ?? "spec-design-agent:local",
  specDesignProvider: process.env.SPEC_DESIGN_AGENT_PROVIDER ?? "claude",
  // env-file passed to the container for provider credentials (ANTHROPIC_API_KEY
  // etc.). Defaults to the spec-design-agent repo's own .runtime.env.
  specDesignRuntimeEnvFile:
    process.env.SPEC_DESIGN_AGENT_RUNTIME_ENV ?? resolve(targetRepo, "..", "spec-design-agent", ".runtime.env"),
  specDesignTimeoutMs: Number(process.env.SPEC_DESIGN_AGENT_TIMEOUT_MS ?? "900000"),
  // Token git inside the container uses to reach GitHub. Defaults to the
  // orchestrator's own token; set SPEC_DESIGN_GITHUB_TOKEN to hand the agent a
  // narrower, read-only credential than the one the Orchestrator pushes with.
  specDesignGithubToken: process.env.SPEC_DESIGN_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
  evaluatorApiUrl: required("EVALUATOR_API_URL"),
  evaluatorApiToken: required("EVALUATOR_API_TOKEN"),
  targetRepo,
  // Where the isolated per-work-item clones are created before being bind-mounted
  // into the container at /work.
  specWorkspaceRoot: process.env.SPEC_WORKSPACE_ROOT ?? resolve(targetRepo, "..", "agentic-sdlc-workspaces"),
  intentBacklogApiBase: process.env.INTENT_BACKLOG_API_BASE ?? "https://api.github.com",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  callbackUrl: required("CALLBACK_URL"),
  port: Number(process.env.PORT ?? "8787"),
};

export const webhookUrl = `${config.callbackUrl.replace(/\/$/, "")}/webhooks/trello`;
