// ABOUTME: Loads repository configuration and user-level evaluator credentials for the orchestrator.
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
  listReady: process.env.TRELLO_LIST_READY ?? "Ready for Agent",
  listWorking: process.env.TRELLO_LIST_WORKING ?? "Agent Working",
  listReview: process.env.TRELLO_LIST_REVIEW ?? "Agent Review",
  listHumanApproval: process.env.TRELLO_LIST_HUMAN_APPROVAL ?? "Human Approval",
  listHumanDecision: process.env.TRELLO_LIST_HUMAN_DECISION ?? "Human Decision Required",
  listSpecDesign: process.env.TRELLO_LIST_SPEC_DESIGN ?? "Spec & Design",
  listDesignReview: process.env.TRELLO_LIST_DESIGN_REVIEW ?? "Design Review",
  wipLimit: Number(process.env.WIP_LIMIT ?? "1"),
  codingAgentCli: required("CODING_AGENT_CLI"),
  // Command that runs the Spec & Design Agent bounded job (see .env.example).
  // Left optional so the coding/evaluation flow still starts before the Spec &
  // Design trigger is configured; a card entering Spec & Design without it set
  // gets a card comment rather than a crash.
  specDesignAgentCli: process.env.SPEC_DESIGN_AGENT_CLI ?? "",
  specDesignAgentProvider: process.env.SPEC_DESIGN_AGENT_PROVIDER ?? "claude",
  evaluatorApiUrl: required("EVALUATOR_API_URL"),
  evaluatorApiToken: required("EVALUATOR_API_TOKEN"),
  targetRepo,
  worktreeRoot: process.env.WORKTREE_ROOT ?? resolve(targetRepo, "..", "agentic-sdlc-worktrees"),
  intentBacklogApiBase: process.env.INTENT_BACKLOG_API_BASE ?? "https://api.github.com",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  callbackUrl: required("CALLBACK_URL"),
  port: Number(process.env.PORT ?? "8787"),
};

export const webhookUrl = `${config.callbackUrl.replace(/\/$/, "")}/webhooks/trello`;
