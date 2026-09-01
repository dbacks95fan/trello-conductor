import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  trelloApiKey: required("TRELLO_API_KEY"),
  trelloToken: required("TRELLO_TOKEN"),
  trelloApiSecret: required("TRELLO_API_SECRET"),
  boardId: required("TRELLO_BOARD_ID"),
  listReady: process.env.TRELLO_LIST_READY ?? "Ready for Agent",
  listWorking: process.env.TRELLO_LIST_WORKING ?? "Agent Working",
  listReview: process.env.TRELLO_LIST_REVIEW ?? "Agent Review",
  wipLimit: Number(process.env.WIP_LIMIT ?? "1"),
  codingAgentCli: required("CODING_AGENT_CLI"),
  targetRepo: required("TARGET_REPO"),
  callbackUrl: required("CALLBACK_URL"),
  port: Number(process.env.PORT ?? "8787"),
};

/** The exact URL registered with Trello for this webhook — signatures are computed
 *  over this full URL (base + path), not the bare CALLBACK_URL. Computed once here
 *  so registration (server.ts) and verification (webhookVerify.ts) can never disagree. */
export const webhookUrl = `${config.callbackUrl.replace(/\/$/, "")}/webhooks/trello`;
