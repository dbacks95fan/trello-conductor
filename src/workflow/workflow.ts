import { CardParseError, contractFromCard } from "./contractFromCard.js";
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { runEvaluatorAgent } from "../evaluatorAgent/runEvaluatorAgent.js";
import { commentOnCard, getCard, getListIdByName, moveCard } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

const pendingQueue: string[] = [];
const pendingReviewQueue: string[] = [];
let processing = false;
let reviewing = false;
const handoffMarker = "<!-- agentic-sdlc-evaluator-handoff ";

export function enqueueCard(cardId: string): void {
  if (!pendingQueue.includes(cardId)) pendingQueue.push(cardId);
  void drainQueue();
}

function enqueueReview(cardId: string): void {
  if (!pendingReviewQueue.includes(cardId)) pendingReviewQueue.push(cardId);
  void drainReviewQueue();
}

async function drainReviewQueue(): Promise<void> {
  if (reviewing) return;
  reviewing = true;
  try {
    while (pendingReviewQueue.length > 0) await evaluateCard(pendingReviewQueue.shift()!);
  } finally {
    reviewing = false;
  }
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
  await commentOnCard(cardId, `🤖 Coding Agent finished: **${codingStatus}**\n\n${codingSummary}`);

  if (codingStatus !== "candidate_complete") {
    await moveCard(cardId, reviewListId);
    await commentOnCard(cardId, "⏸️ Evaluator was not invoked because only `candidate_complete` implementations are eligible for independent evaluation.");
    return;
  }

  const workItem = String(coding.evidence.workItem ?? contract.work_item);
  const runId = String(coding.evidence.runId ?? "");
  if (!runId) {
    await moveCard(cardId, reviewListId);
    await commentOnCard(cardId, "❌ Coding Agent did not provide a run ID. Independent evaluation cannot be started.");
    return;
  }
  const contractRelativePath = `.agent/work/${workItem}/contract.yaml`;
  const evidenceRelativePath = `.agent/evidence/${workItem}-${runId}.json`;
  const contractAbsolutePath = join(config.targetRepo, contractRelativePath);
  mkdirSync(join(config.targetRepo, ".agent", "work", workItem), { recursive: true });
  writeFileSync(contractAbsolutePath, stringify(contract), "utf8");
  const handoff = JSON.stringify({ contractPath: contractRelativePath, evidencePath: evidenceRelativePath, runId });
  await commentOnCard(cardId, `${handoffMarker}${handoff} -->\n🔎 Independent evaluation is ready. Moving this card to Agent Review starts the Evaluator Agent.`);
  await moveCard(cardId, reviewListId);
}

async function evaluateCard(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  const { getCardComments } = await import("../trello/client.js");
  const comments = await getCardComments(cardId);
  const handoffComment = comments.find((comment) => comment.data.text?.startsWith(handoffMarker));
  if (!handoffComment?.data.text) {
    await commentOnCard(cardId, "⚠️ Agent Review was entered without an evaluator handoff. No evaluator run was started.");
    return;
  }
  let handoff: { contractPath?: string; evidencePath?: string };
  try {
    const payload = handoffComment.data.text.slice(handoffMarker.length).split(" -->", 1)[0];
    handoff = JSON.parse(payload);
  } catch {
    await commentOnCard(cardId, "⚠️ The evaluator handoff metadata is invalid. No evaluator run was started.");
    return;
  }
  if (!handoff.contractPath || !handoff.evidencePath) {
    await commentOnCard(cardId, "⚠️ The evaluator handoff is incomplete. No evaluator run was started.");
    return;
  }
  const contractText = await (await import("node:fs/promises")).readFile(join(config.targetRepo, handoff.contractPath), "utf8");
  const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(join(config.targetRepo, handoff.evidencePath), "utf8")) as Record<string, unknown>;
  await commentOnCard(cardId, "🔎 Independent Evaluator Agent started because the card entered Agent Review.");

  let evaluated;
  try {
    evaluated = await runEvaluatorAgent(contractText, evidence);
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

export function handleCardReviewForAgent(cardId: string): void {
  enqueueReview(cardId);
}
