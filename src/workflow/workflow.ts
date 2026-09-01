import { CardParseError, contractFromCard } from "./contractFromCard.js";
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { commentOnCard, getCard, getListIdByName, moveCard } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";

// Simple in-memory FIFO for cards that arrived while WIP was full. Not persisted
// across restarts — acceptable for v0.1; a card still sitting in "Ready for
// Agent" after a restart needs a human to move it out and back in (or a future
// periodic sweep) to re-trigger. Documented, not silently hidden.
const pendingQueue: string[] = [];
let processing = false;

export function enqueueCard(cardId: string): void {
  if (!pendingQueue.includes(cardId)) pendingQueue.push(cardId);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (pendingQueue.length > 0) {
      if (!(await isUnderWipLimit())) {
        console.log(`[trello-conductor] WIP limit reached (${config.wipLimit}); ${pendingQueue.length} card(s) queued.`);
        return;
      }
      const cardId = pendingQueue.shift()!;
      await processCard(cardId);
    }
  } finally {
    processing = false;
  }
}

async function processCard(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  console.log(`[trello-conductor] Processing card ${card.idShort} "${card.name}"`);

  let contract;
  try {
    contract = contractFromCard(card);
  } catch (err) {
    if (err instanceof CardParseError) {
      await commentOnCard(
        cardId,
        `⚠️ Trello Conductor could not build a Work Contract from this card and is leaving it in place:\n\n${err.message}\n\nFix the card description (needs a USER STORY section and at least one ACCEPTANCE CRITERIA bullet) and move it back to "${config.listReady}" to retry.`,
      );
      return;
    }
    throw err;
  }

  const workingListId = await getListIdByName(config.listWorking);
  await moveCard(cardId, workingListId);
  await commentOnCard(cardId, `🤖 Coding Agent started (work item \`${contract.work_item}\`).`);

  const result = await runCodingAgent(contract);
  const reviewListId = await getListIdByName(config.listReview);

  if (!result.evidence) {
    await moveCard(cardId, reviewListId);
    await commentOnCard(
      cardId,
      `❌ Coding Agent produced no parseable output (exit code ${result.exitCode}). Raw output (truncated):\n\n\`\`\`\n${result.rawOutput.slice(-1500)}\n\`\`\`\n\nNeeds human investigation.`,
    );
    return;
  }

  const status = String(result.evidence.status ?? "unknown");
  const summary = String(result.evidence.summary ?? "(no summary)");

  await moveCard(cardId, reviewListId);

  const statusEmoji: Record<string, string> = {
    candidate_complete: "✅",
    blocked: "⏸️",
    needs_decision: "❓",
    failed: "❌",
  };

  let comment = `${statusEmoji[status] ?? "ℹ️"} Coding Agent finished: **${status}**\n\n${summary}`;

  if (status === "needs_decision" && Array.isArray(result.evidence.escalations)) {
    for (const esc of result.evidence.escalations as Array<Record<string, unknown>>) {
      comment += `\n\n**Escalation**: ${esc.issue}\n**Recommendation**: ${esc.recommendation ?? "(none given)"}`;
    }
  }

  const validation = result.evidence.validation as Record<string, { status: string }> | undefined;
  if (validation) {
    const gateSummary = Object.entries(validation)
      .map(([gate, v]) => `${gate}: ${v.status}`)
      .join(", ");
    comment += `\n\nValidation — ${gateSummary}`;
  }

  comment += `\n\nEvidence saved at \`.agent/evidence/${contract.work_item}-${result.evidence.runId}.json\` in the repo. This card requires human review — Trello Conductor never moves a card to Done.`;

  await commentOnCard(cardId, comment);
  console.log(`[trello-conductor] Card ${card.idShort} -> Agent Review (${status})`);
}

/** Called on every webhook delivery indicating a card entered TRELLO_LIST_READY. */
export function handleCardReadyForAgent(cardId: string): void {
  enqueueCard(cardId);
}
