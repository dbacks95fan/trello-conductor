// ABOUTME: Coordinates spec & design, coding, and remote evaluation transitions for Trello work items.
import { CardParseError, contractFromCard } from "./contractFromCard.js";
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { CONTAINER_WORKSPACE, runSpecDesignAgent, type SpecDesignRequest } from "../specDesignAgent/runSpecDesignAgent.js";
import { resolveSpecRequest, SpecRequestError } from "./specRequestFromCard.js";
import { routeSpecResult } from "./specRouting.js";
import { prepareSpecWorkspace, publishSpecBranch } from "./specWorkspace.js";
import { prepareGitEvaluationHandoff } from "../evaluatorAgent/gitHandoff.js";
import { runRemoteEvaluator } from "../evaluatorAgent/remote.js";
import { commentOnCard, getCard, getListIdByName, moveCard } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stringify } from "yaml";

export interface MoveApproval {
  approvedBy: string;
  approvedAt: string;
}

const pendingQueue: string[] = [];
const pendingReviewQueue: string[] = [];
const pendingSpecQueue: Array<{ cardId: string; approval: MoveApproval }> = [];
let processing = false;
let reviewing = false;
let specing = false;
const handoffMarker = "<!-- agentic-sdlc-evaluator-handoff ";

export function enqueueCard(cardId: string): void {
  if (!pendingQueue.includes(cardId)) pendingQueue.push(cardId);
  void drainQueue();
}

function enqueueReview(cardId: string): void {
  if (!pendingReviewQueue.includes(cardId)) pendingReviewQueue.push(cardId);
  void drainReviewQueue();
}

function enqueueSpec(cardId: string, approval: MoveApproval): void {
  if (!pendingSpecQueue.some((entry) => entry.cardId === cardId)) {
    pendingSpecQueue.push({ cardId, approval });
  }
  void drainSpecQueue();
}

async function drainSpecQueue(): Promise<void> {
  if (specing) return;
  specing = true;
  try {
    while (pendingSpecQueue.length > 0) {
      const next = pendingSpecQueue.shift()!;
      await processSpecCard(next.cardId, next.approval);
    }
  } finally {
    specing = false;
  }
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
  const worktree = coding.evidence.worktree as { path?: string; branch?: string } | undefined;
  if (!runId) {
    await moveCard(cardId, reviewListId);
    await commentOnCard(cardId, "❌ Coding Agent did not provide a run ID. Independent evaluation cannot be started.");
    return;
  }
  if (!worktree?.path || !worktree.branch) {
    await moveCard(cardId, reviewListId);
    await commentOnCard(cardId, "❌ Coding Agent did not provide a candidate worktree path and branch. Independent evaluation cannot be started.");
    return;
  }
  const handoff = await prepareGitEvaluationHandoff({
    workItem,
    worktreePath: worktree.path,
    branch: String(worktree.branch ?? ""),
    intentPath: contract.intent.path,
    contractText: stringify(contract),
    evidencePath: join(config.targetRepo, ".agent", "evidence", `${workItem}-${runId}.json`),
  });
  const handoffComment = JSON.stringify(handoff);
  await commentOnCard(cardId, `${handoffMarker}${handoffComment} -->\n🔎 Independent evaluation is ready from Git revision \`${handoff.revision}\`. Moving this card to Agent Review starts the Evaluator Agent.`);
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
  let handoff: { repositoryUrl?: string; revision?: string; intentPath?: string; contractPath?: string; evidencePath?: string };
  try {
    const payload = handoffComment.data.text.slice(handoffMarker.length).split(" -->", 1)[0];
    handoff = JSON.parse(payload);
  } catch {
    await commentOnCard(cardId, "⚠️ The evaluator handoff metadata is invalid. No evaluator run was started.");
    return;
  }
  if (!handoff.repositoryUrl || !handoff.revision || !handoff.intentPath || !handoff.contractPath || !handoff.evidencePath) {
    await commentOnCard(cardId, "⚠️ The evaluator handoff is incomplete. No evaluator run was started.");
    return;
  }
  await commentOnCard(cardId, "🔎 Independent Evaluator Agent started because the card entered Agent Review.");

  let evaluated;
  try {
    evaluated = await runRemoteEvaluator({
      endpoint: `${config.evaluatorApiUrl.replace(/\/$/, "")}/evaluations`,
      token: config.evaluatorApiToken,
      repositoryUrl: handoff.repositoryUrl,
      revision: handoff.revision,
      workItem: String(card.idShort),
      intentPath: handoff.intentPath,
      contractPath: handoff.contractPath,
      evidencePath: handoff.evidencePath,
    });
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

async function processSpecCard(cardId: string, approval: MoveApproval): Promise<void> {
  try {
    await runSpecAndDesign(cardId, approval);
  } catch (err) {
    console.error(`[trello-conductor] Spec & Design failed for card ${cardId}:`, err);
    await commentOnCard(
      cardId,
      `❌ Spec & Design could not be completed for this card: ${err instanceof Error ? err.message : String(err)}. The card stays in Spec & Design.`,
    ).catch(() => undefined);
  }
}

async function runSpecAndDesign(cardId: string, approval: MoveApproval): Promise<void> {
  const card = await getCard(cardId);
  console.log(`[trello-conductor] Spec & Design for card ${card.idShort} "${card.name}"`);

  let resolved;
  try {
    resolved = await resolveSpecRequest(card, {
      githubApiBase: config.intentBacklogApiBase,
      githubToken: config.githubToken,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    });
  } catch (err) {
    if (err instanceof SpecRequestError) {
      await commentOnCard(cardId, `⚠️ Spec & Design Agent was not started:\n\n${err.message}`);
      return;
    }
    throw err;
  }

  for (const warning of resolved.warnings) {
    await commentOnCard(cardId, `⚠️ ${warning}`);
  }

  let workspace;
  try {
    workspace = await prepareSpecWorkspace({
      targetRepo: config.targetRepo,
      workspaceRoot: config.specWorkspaceRoot,
      intentId: resolved.intentId,
      frozenIntentBytes: resolved.frozenIntentBytes,
    });
  } catch (err) {
    await commentOnCard(
      cardId,
      `❌ Could not create the isolated \`work/${resolved.intentId}\` workspace for Spec & Design: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const request: SpecDesignRequest = {
    runId: randomUUID(),
    workItem: resolved.intentId,
    productId: resolved.productId,
    intent: {
      repository: resolved.intentRepository,
      commit: resolved.intentCommit,
      path: resolved.intentPath,
      frozenArtifactSha256: workspace.frozenArtifactSha256,
      contentSha256: resolved.intentContentSha256,
    },
    target: {
      repository: config.targetRepo,
      baseCommit: workspace.baseCommit,
      branch: workspace.branch,
      // The agent reads this from inside the container, where the host clone is
      // bind-mounted at /work.
      workspace: CONTAINER_WORKSPACE,
    },
    approval: {
      readyForPlanning: true,
      approvedBy: resolved.approvedBy,
      approvedAt: resolved.approvedAt,
    },
  };

  await commentOnCard(
    cardId,
    `🧭 Spec & Design Agent container started for \`${request.workItem}\` (run \`${request.runId}\`) on branch \`${workspace.branch}\`.`,
  );

  const run = await runSpecDesignAgent(request, { hostWorkspace: workspace.path });
  const route = routeSpecResult(run);
  await commentOnCard(cardId, route.comment);

  if (route.destination === "design-review") {
    // Design Review is a human step, so the spec has to exist somewhere a
    // reviewer can open. The Conductor publishes the branch — the agent has no
    // write authority over the product repository (AGENT_ROLES.md).
    const published = await publishSpecBranch(workspace, config.githubToken);
    await commentOnCard(
      cardId,
      published.pushed
        ? `📤 Work branch published for Design Review: ${published.branchUrl}`
        : `⚠️ The spec is committed locally on \`${workspace.branch}\` but could not be pushed for review: ${published.reason}`,
    );
    await moveCard(cardId, await getListIdByName(config.listDesignReview));
  } else if (route.destination === "human-decision") {
    await moveCard(cardId, await getListIdByName(config.listHumanDecision));
  }
}

export function handleCardReadyForAgent(cardId: string): void {
  enqueueCard(cardId);
}

export function handleCardReviewForAgent(cardId: string): void {
  enqueueReview(cardId);
}

export function handleCardSpecAndDesign(cardId: string, approval: MoveApproval): void {
  enqueueSpec(cardId, approval);
}
