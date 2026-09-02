import express from "express";
import { config, webhookUrl } from "./config.js";
import { ensureWebhook, getListIdByName, resolveBoardId } from "./trello/client.js";
import { verifyTrelloSignature } from "./trello/webhookVerify.js";
import { handleCardReadyForAgent, handleCardReviewForAgent } from "./workflow/workflow.js";

const app = express();

// Trello signs over the exact raw bytes of the request body — capture them
// before any JSON parsing/re-serialization would alter whitespace/key order.
app.use("/webhooks/trello", express.raw({ type: "*/*" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Trello sends a HEAD request when a webhook is first registered, just to
// confirm the callback URL is reachable. Must return 2xx or registration fails.
app.head("/webhooks/trello", (_req, res) => {
  res.sendStatus(200);
});

app.post("/webhooks/trello", async (req, res) => {
  const rawBody = req.body as Buffer;
  const signature = req.header("X-Trello-Webhook");

  if (!verifyTrelloSignature(rawBody, signature)) {
    console.warn("[trello-conductor] Rejected webhook delivery: invalid signature.");
    res.sendStatus(401);
    return;
  }

  // Ack immediately — Trello expects a fast response and may disable the
  // webhook after repeated timeouts. Actual work happens after responding.
  res.sendStatus(200);

  let payload: { action?: { type?: string; data?: Record<string, unknown> } };
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.warn("[trello-conductor] Webhook body was not valid JSON.");
    return;
  }

  const action = payload.action;
  if (!action || action.type !== "updateCard") return;

  const data = action.data as { listAfter?: { name?: string }; card?: { id?: string } };
  const movedIntoReady = data.listAfter?.name === config.listReady;
  const movedIntoReview = data.listAfter?.name === config.listReview;
  const cardId = data.card?.id;

  if (movedIntoReady && cardId) {
    console.log(`[trello-conductor] Card ${cardId} moved into "${config.listReady}".`);
    handleCardReadyForAgent(cardId);
  } else if (movedIntoReview && cardId) {
    console.log(`[trello-conductor] Card ${cardId} moved into "${config.listReview}".`);
    handleCardReviewForAgent(cardId);
  }
});

async function main() {
  // Fail fast and loud if the configured lists don't exist — better than
  // silently never matching anything.
  await getListIdByName(config.listReady);
  await getListIdByName(config.listWorking);
  await getListIdByName(config.listReview);

  // Must be listening BEFORE asking Trello to register the webhook — Trello
  // does an immediate reachability check (a HEAD request) against the callback
  // URL as part of registration, which would fail against a tunnel pointed at
  // a port nothing is serving yet.
  await new Promise<void>((resolvePromise) => {
    app.listen(config.port, () => {
      console.log(`[trello-conductor] listening on :${config.port}`);
      resolvePromise();
    });
  });

  const boardRealId = await resolveBoardId();
  const webhook = await ensureWebhook(webhookUrl, boardRealId);
  console.log(`[trello-conductor] Webhook active: ${webhook.id} -> ${webhook.callbackURL}`);
}

main().catch((err) => {
  console.error("[trello-conductor] failed to start:", err);
  process.exit(1);
});
