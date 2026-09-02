import { CardParseError, contractFromCard } from "./contractFromCard.js";
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { runEvaluatorAgent } from "../evaluatorAgent/runEvaluatorAgent.js";
import { commentOnCard, getCard, getListIdByName, moveCard } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";

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
      if (!(await isUnderWipLimit())) return;
      await processCard(pendingQueue.shift()!);
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
    contract = contractFromCard(card, config.targetRepo);
  } catch (err) {
    if (err instanceof CardParseError) {
      await commentOnCard(cardId, `⚠️ Trello Conductor could not build a Work Contract:\n\n${err.message}`);
      return;
    }
    throw err;
  }

  const workingListId = await getListIdByName(config.listWorking);
  const reviewListId = await getListIdByName(config.listReview);
  await moveCard(cardId, workingListId);
  await commentOnCard(cardId, `🤖 Coding Agent started (work item \`${contract.work_item}\`).`);

  const coding = await runCodingAgent(contract);
  if (!coding.evidence) {
    await moveCard(cardId, reviewListId);
    await commentOnCard(cardId, `❌ Coding Agent produced no parseable output (exit code ${coding.exitCode}). Needs human investigation.`);
    return;
  }

  const codingStatus = String(coding.evidence.status ?? "unknown");
  const codingSummary = String(coding.evidence.summary ?? "(no summary)");
  await moveCard(cardId, reviewListId);
  await commentOnCard(cardId, `🤖 Coding Agent finished: **${codingStatus}**\n\n${codingSummary}`);

  if (codingStatus !== "candidate_complete") {
    await commentOnCard(cardId, "⏸️ Evaluator was not invoked because only `candidate_complete` implementations are eligible for independent evaluation.");
    return;
  }

  await commentOnCard(cardId, "🔎 Independent Evaluator Agent started.");

  let evaluated;
  try {
    evaluated = await runEvaluatorAgent(coding.contractText, coding.evidence);
  } catch (err) {
    await commentOnCard(cardId, `❌ Evaluator could not start: ${err instanceof Error ? err.message : String(err)}. Card remains in Agent Review.`);
    return;
  }

  if (!evaluated.evaluation) {
    await commentOnCard(cardId, `❌ Evaluator produced no parseable result (exit code ${evaluated.exitCode}). Card remains in Agent Review for investigation.\n\n\`\`\`\n${evaluated.rawOutput.slice(-1500)}\n\`\`\``);
    return;
  }

  const status = String(evaluated.evaluation.status ?? "unknown");
  const summary = String(evaluated.evaluation.summary ?? "(no summary)");
  const findings = Array.isArray(evaluated.evaluation.findings) ? evaluated.evaluation.findings as Array<Record<string, unknown>> : [];
  let comment = `🔎 Evaluator finished: **${status.toUpperCase()}**\n\n${summary}`;
  if (findings.length > 0) {
    comment += "\n\n**Findings**";
    for (const finding of findings.slice(0, 10)) {
      comment += `\n- ${finding.id ?? "finding"} [${finding.severity ?? "unknown"}]: ${finding.problem ?? "(no description)"}`;
    }
  }
  const decisionBrief = evaluated.evaluation.decisionBrief as Record<string, unknown> | undefined;
  if (status === "needs_decision" && decisionBrief) {
    const facts = Array.isArray(decisionBrief.knownFacts) ? decisionBrief.knownFacts : [];
    const inferences = Array.isArray(decisionBrief.evaluatorInferences) ? decisionBrief.evaluatorInferences : [];
    const options = Array.isArray(decisionBrief.options) ? decisionBrief.options as Array<Record<string, unknown>> : [];
    comment += `\n\n## Human Decision Required\n\n**Decision:** ${decisionBrief.decisionRequired ?? "Not provided"}\n\n**Why now:** ${decisionBrief.whyNow ?? "Not provided"}`;
    if (facts.length) comment += `\n\n**Known facts**\n${facts.map((fact) => `- ${String(fact)}`).join("\n")}`;
    if (inferences.length) comment += `\n\n**Evaluator inferences**\n${inferences.map((inference) => `- ${String(inference)}`).join("\n")}`;
    if (options.length) comment += `\n\n**Options**\n${options.map((option) => `- ${String(option.option ?? "Option")}: ${String(option.impact ?? "Impact not provided")}`).join("\n")}`;
    comment += `\n\n**If no decision is made:** ${decisionBrief.consequenceOfNoDecision ?? "Work remains blocked."}`;
  }
  await commentOnCard(cardId, comment);

  if (status === "pass") {
    const humanApprovalListId = await getListIdByName(config.listHumanApproval);
    await moveCard(cardId, humanApprovalListId);
    await commentOnCard(cardId, "✅ Independent evaluation passed. Awaiting Human Approval. Trello Conductor never moves work to Done.");
  } else if (status === "fail") {
    await commentOnCard(cardId, "↩️ Independent evaluation failed. Findings require implementation rework. Card remains in Agent Review; automatic retry is intentionally not enabled in v0.1.");
  } else if (status === "needs_decision") {
    const humanDecisionListId = await getListIdByName(config.listHumanDecision);
    await moveCard(cardId, humanDecisionListId);
    await commentOnCard(cardId, "❓ Evaluator requires human judgment. The decision brief above contains the evidence, options, and consequence of waiting.");
  } else {
    await commentOnCard(cardId, `⚠️ Unknown evaluator status \`${status}\`. Card remains in Agent Review.`);
  }
}

export function handleCardReadyForAgent(cardId: string): void {
  enqueueCard(cardId);
}
