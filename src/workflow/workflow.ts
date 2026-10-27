// ABOUTME: Coordinates spec & design, coding, and remote evaluation transitions for Trello work items.
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { CONTAINER_WORKSPACE, runSpecDesignAgent, type SpecDesignRequest } from "../specDesignAgent/runSpecDesignAgent.js";
import { resolveSpecRequest, SpecRequestError } from "./specRequestFromCard.js";
import { routeSpecResult } from "./specRouting.js";
import { prepareSpecWorkspace, publishSpecBranch, readCommittedWorkspaceFile } from "./specWorkspace.js";
import { prepareGitEvaluationHandoff } from "../evaluatorAgent/gitHandoff.js";
import { runRemoteEvaluator } from "../evaluatorAgent/remote.js";
import { commentOnCard, getCard, getListIdByName, moveCard, updateCardDescription } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringify } from "yaml";
import { activeFreezeForCard, readFreezeProjection, writeFreezeProjection, type FreezeTuple } from "./freezeState.js";
import { frozenArtifactSha256 } from "./specRequestFromCard.js";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { parse as parseYaml } from "yaml";
import { validateWorkContractV3 } from "./workContractV3.js";
import { adaptAcceptedWorkContract } from "./codingContractAdapter.js";
import type { WorkContract } from "./contractFromCard.js";
import { loadAcceptedExecutionContract } from "./acceptedExecutionContract.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);

export interface MoveApproval {
  approvedBy: string;
  approvedAt: string;
  eventId?: string;
}

interface AcceptedExecution {
  cardId: string;
  acceptance: Record<string, unknown>;
  workspaceRef: string;
  targetCommit: string;
}
const pendingQueue: AcceptedExecution[] = [];
const pendingReviewQueue: string[] = [];
const pendingSpecQueue: Array<{ cardId: string; approval: MoveApproval }> = [];
let processing = false;
let reviewing = false;
let specing = false;
const handoffMarker = "<!-- agentic-sdlc-evaluator-handoff ";

export function enqueueCard(execution: AcceptedExecution): void {
  if (!pendingQueue.some((entry) => entry.cardId === execution.cardId)) pendingQueue.push(execution);
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
      if (!(await isUnderWipLimit(pendingQueue[0].cardId))) return;
      await processCard(pendingQueue.shift()!);
    }
  } finally {
    processing = false;
  }
}

async function processCard(execution: AcceptedExecution): Promise<void> {
  const { cardId } = execution;
  const card = await getCard(cardId);
  console.log(`[trello-conductor] Processing card ${card.idShort} "${card.name}"`);

  let contract: WorkContract;
  let repositoryPath = "";
  let baseBranch = "";
  try {
    const executionListId = await getListIdByName(config.listWorking);
    if (card.idList !== executionListId) throw new Error("The card no longer resides in Execution.");
    const loaded = await loadAcceptedExecutionContract({
      card,
      acceptance: execution.acceptance,
      workspaceRef: execution.workspaceRef,
      targetCommit: execution.targetCommit,
      workspaceRoot: config.specWorkspaceRoot,
      intentBacklogApiBase: config.intentBacklogApiBase,
      githubToken: config.githubToken,
      validator: lifecycleValidator,
    });
    contract = loaded.workContract;
    repositoryPath = loaded.repositoryPath;
    baseBranch = loaded.baseBranch;
  } catch (err) {
    if (err instanceof Error) {
      await commentOnCard(cardId, `⚠️ Trello Conductor could not build a Work Contract:\n\n${err.message}`);
      return;
    }
    throw err;
  }

  const workingListId = await getListIdByName(config.listWorking);
  const reviewListId = await getListIdByName(config.listReview);
  if (card.idList !== workingListId) return;
  await commentOnCard(cardId, `🤖 Coding Agent started (work item \`${contract.work_item}\`).`);

  const coding = await runCodingAgent(contract, { repoRoot: repositoryPath, baseBranch });
  if (!coding.evidence) {
    await commentOnCard(cardId, `❌ Coding Agent produced no parseable output (exit code ${coding.exitCode}). Needs human investigation.`);
    return;
  }

  const codingStatus = String(coding.evidence.status ?? "unknown");
  const codingSummary = String(coding.evidence.summary ?? "(no summary)");
  await commentOnCard(cardId, `🤖 Coding Agent finished: **${codingStatus}**\n\n${codingSummary}`);

  if (codingStatus !== "candidate_complete") {
    await commentOnCard(cardId, "⏸️ Evaluator was not invoked because only `candidate_complete` implementations are eligible for independent evaluation.");
    return;
  }

  const workItem = String(coding.evidence.workItem ?? contract.work_item);
  const runId = String(coding.evidence.runId ?? "");
  const worktree = coding.evidence.worktree as { path?: string; branch?: string } | undefined;
  if (!runId) {
    await commentOnCard(cardId, "❌ Coding Agent did not provide a run ID. Independent evaluation cannot be started.");
    return;
  }
  if (!worktree?.path || !worktree.branch) {
    await commentOnCard(cardId, "❌ Coding Agent did not provide a candidate worktree path and branch. Independent evaluation cannot be started.");
    return;
  }
  const handoff = await prepareGitEvaluationHandoff({
    workItem,
    worktreePath: worktree.path,
    branch: String(worktree.branch ?? ""),
    intentPath: contract.intent.path,
    contractText: stringify(contract),
    evidencePath: join(repositoryPath, ".agent", "evidence", `${workItem}-${runId}.json`),
  });
  const handoffComment = JSON.stringify(handoff);
  await commentOnCard(cardId, `${handoffMarker}${handoffComment} -->\n🔎 Independent evaluation is ready from Git revision \`${handoff.revision}\`. Moving this card to ${config.listReview} starts the Evaluator Agent.`);
  await moveCard(cardId, reviewListId);
}

async function evaluateCard(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  const { getCardComments } = await import("../trello/client.js");
  const comments = await getCardComments(cardId);
  const handoffComment = comments.find((comment) => comment.data.text?.startsWith(handoffMarker));
  if (!handoffComment?.data.text) {
    await commentOnCard(cardId, `⚠️ ${config.listReview} was entered without an evaluator handoff. No evaluator run was started.`);
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
  await commentOnCard(cardId, `🔎 Independent Evaluator Agent started because the card entered ${config.listReview}.`);

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
    await commentOnCard(cardId, `❌ Evaluator could not start: ${err instanceof Error ? err.message : String(err)}. Card remains in ${config.listReview}.`);
    return;
  }

  if (!evaluated.evaluation) {
    await commentOnCard(cardId, `❌ Evaluator produced no parseable result (exit code ${evaluated.exitCode}). Card remains in ${config.listReview} for investigation.\n\n\`\`\`\n${evaluated.rawOutput.slice(-1500)}\n\`\`\``);
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
    await commentOnCard(cardId, `↩️ Independent evaluation failed. Findings require implementation rework. Card remains in ${config.listReview}; automatic retry is intentionally not enabled in v0.1.`);
  } else if (status === "needs_decision") {
    // Keep the request in Evaluation; the card move itself remains human-authorized.
    await commentOnCard(cardId, "❓ Evaluator requires human judgment. The decision brief above contains the evidence, options, and consequence of waiting.");
  } else {
    await commentOnCard(cardId, `⚠️ Unknown evaluator status \`${status}\`. Card remains in ${config.listReview}.`);
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
  const activeFreeze = activeFreezeForCard(card);
  if (!activeFreeze) {
    await commentOnCard(cardId, "⛔ Spec & Design was not started: this card has no active Prioritized freeze. Return it to Backlog, reconcile the intent, then move it to Prioritized.");
    return;
  }

  let resolved;
  try {
    resolved = await resolveSpecRequest(card, {
      githubApiBase: config.intentBacklogApiBase,
      githubToken: config.githubToken,
      approvedBy: activeFreeze.tuple.authorizedBy,
      approvedAt: activeFreeze.tuple.frozenAt,
    });
  } catch (err) {
    if (err instanceof SpecRequestError) {
      await commentOnCard(cardId, `⚠️ Spec & Design Agent was not started:\n\n${err.message}`);
      return;
    }
    throw err;
  }

  if (
    frozenArtifactSha256(resolved.frozenIntentBytes) !== activeFreeze.tuple.intentSha256 ||
    resolved.productId !== activeFreeze.tuple.productId ||
    resolved.intentId !== activeFreeze.tuple.intentId ||
    resolved.intentVersion !== activeFreeze.tuple.intentVersion ||
    resolved.intentCommit !== activeFreeze.tuple.intentCommit ||
    resolved.policyProfileId !== activeFreeze.tuple.policyProfileId ||
    resolved.policyProfileVersion !== activeFreeze.tuple.policyProfileVersion ||
    resolved.policyProfileContentSha256 !== activeFreeze.tuple.policyProfileSha256
  ) {
    await commentOnCard(cardId, "⛔ Spec & Design was not started: the current intent or policy profile does not match the active Prioritized freeze.");
    return;
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
      frozenPolicyProfileBytes: resolved.frozenPolicyProfileBytes,
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
    policyProfile: {
      repository: resolved.intentRepository,
      commit: resolved.intentCommit,
      path: resolved.policyProfilePath,
      profileId: resolved.policyProfileId,
      version: resolved.policyProfileVersion,
      frozenArtifactSha256: resolved.policyProfileContentSha256,
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
      prioritized: true,
      approvedBy: resolved.approvedBy,
      approvedAt: resolved.approvedAt,
    },
  };

  const stageInvocation = {
    schema_version: "1.0",
    invocation_id: request.runId,
    trigger_event_id: approval.eventId ?? request.runId,
    stage: "spec_design",
    work_item: { product_id: resolved.productId, intent_id: resolved.intentId, intent_version: resolved.intentVersion, trello_card_id: cardId },
    input_artifacts: [
      { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.intentPath, sha256: resolved.intentContentSha256 },
      { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.policyProfilePath, sha256: resolved.policyProfileContentSha256 },
    ],
    target: { repository: workspace.remoteUrl.replace(/\.git$/, ""), commit_sha: workspace.baseCommit },
    workspace_ref: workspace.branch,
    read_paths: ["."],
    write_paths: [`.agent/work/${resolved.intentId}/spec.md`, `.agent/work/${resolved.intentId}/work-contract.yaml`],
  };
  const invocationValidation = lifecycleValidator.validate("StageInvocation", stageInvocation);
  if (!invocationValidation.valid) {
    await commentOnCard(cardId, `? Spec & Design invocation was not started because its StageInvocation record is invalid: ${invocationValidation.errors.join("; ")}`);
    return;
  }
  await commentOnCard(cardId, `<!-- agentic-sdlc-stage-invocation ${JSON.stringify(stageInvocation)} -->\nValidated Spec & Design StageInvocation recorded.`);

  const recordStageResult = async (status: "spec_ready" | "needs_decision" | "blocked" | "failed", outputArtifacts: unknown[], summary: string, findings?: string[]) => {
    const stageResult = {
      schema_version: "1.0",
      invocation_id: request.runId,
      stage: "spec_design",
      work_item: stageInvocation.work_item,
      status,
      output_artifacts: outputArtifacts,
      summary,
      ...(findings?.length ? { findings } : {}),
    };
    const resultValidation = lifecycleValidator.validate("StageResult", stageResult);
    if (!resultValidation.valid) {
      await commentOnCard(cardId, `? Spec & Design StageResult was rejected because it is invalid: ${resultValidation.errors.join("; ")}`);
      return false;
    }
    await commentOnCard(cardId, `<!-- agentic-sdlc-stage-result ${JSON.stringify(stageResult)} -->\nValidated Spec & Design StageResult recorded.`);
    return true;
  };

  await commentOnCard(
    cardId,
    `🧭 Spec & Design Agent container started for \`${request.workItem}\` (run \`${request.runId}\`) on branch \`${workspace.branch}\`.`,
  );

  const run = await runSpecDesignAgent(request, { hostWorkspace: workspace.path });
  const route = routeSpecResult(run);
  const rawStatus = String(run.result?.status ?? "failed");
  const safeStatus = (["spec_ready", "needs_decision", "blocked", "failed"].includes(rawStatus) ? rawStatus : "failed") as "spec_ready" | "needs_decision" | "blocked" | "failed";
  if (run.result?.status === "spec_ready") {
    const contractPath = typeof run.result.workContractPath === "string" ? run.result.workContractPath : "";
    const specCommit = typeof run.result.specCommit === "string" ? run.result.specCommit : "";
    if (!contractPath || !specCommit) {
      await recordStageResult("blocked", [], "Spec & Design omitted the committed Work Contract v3 reference.", ["Missing workContractPath or specCommit"]);
      await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review: it must include a committed Work Contract v3 path and commit reference. The current Spec & Design Agent result does not provide that contract yet.");
      return;
    }
    try {
      const contractText = await readCommittedWorkspaceFile(workspace.path, specCommit, contractPath);
      const contract = parseYaml(contractText);
      const issues = validateWorkContractV3(contract, {
        productId: resolved.productId,
        intentId: resolved.intentId,
        intentVersion: resolved.intentVersion,
        cardId: card.id,
        intentRepository: `https://github.com/${resolved.intentRepository}`,
        intentCommit: resolved.intentCommit,
        intentPath: resolved.intentPath,
        intentSha256: frozenArtifactSha256(resolved.frozenIntentBytes),
        policyProfileId: resolved.policyProfileId,
        policyProfileVersion: resolved.policyProfileVersion,
        policyProfilePath: resolved.policyProfilePath,
        policyProfileSha256: resolved.policyProfileContentSha256,
        targetRepository: workspace.remoteUrl.replace(/\.git$/, ""),
        targetCommit: workspace.baseCommit,
      }, lifecycleValidator);
      if (issues.length > 0) {
        await recordStageResult("blocked", [], "The proposed Work Contract v3 failed canonical schema or frozen-reference checks.", issues);
        await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review:\n\n" + issues.map((issue) => `- ${issue}`).join("\n"));
        return;
      }
      const specPath = typeof run.result.specPath === "string" ? run.result.specPath : "";
      if (!specPath) {
        await recordStageResult("blocked", [], "Spec & Design omitted the committed spec.md path.", ["Missing specPath"]);
        await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review: the committed spec.md path is missing.");
        return;
      }
      const specText = await readCommittedWorkspaceFile(workspace.path, specCommit, specPath);
      const repository = workspace.remoteUrl.replace(/\.git$/, "");
      const outputArtifacts = [
        { repository, commit_sha: specCommit, path: specPath, sha256: createHash("sha256").update(specText, "utf8").digest("hex") },
        { repository, commit_sha: specCommit, path: contractPath, sha256: createHash("sha256").update(contractText, "utf8").digest("hex") },
      ];
      if (!(await recordStageResult("spec_ready", outputArtifacts, String(run.result.summary ?? "Spec and Work Contract v3 are ready for human review.")))) return;
    } catch (err) {
      await recordStageResult("blocked", [], "The committed Work Contract v3 could not be read, parsed, or validated.", [err instanceof Error ? err.message : String(err)]);
      await commentOnCard(cardId, `? The committed Work Contract v3 could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    const summary = String(run.result?.summary ?? "The Spec & Design Agent did not return a parseable successful result.");
    const findings = Array.isArray(run.result?.blockingConcerns) ? run.result.blockingConcerns.map(String) : [];
    if (!(await recordStageResult(safeStatus, [], summary, findings))) return;
  }
  await commentOnCard(cardId, route.comment);

  if (route.comment.includes("spec ready for human review")) {
    const published = await publishSpecBranch(workspace, config.githubToken);
    await commentOnCard(
      cardId,
      published.pushed
        ? `📤 Work branch published for Design Review: ${published.branchUrl}`
        : `⚠️ The spec is committed locally on \`${workspace.branch}\` but could not be pushed for review: ${published.reason}`,
    );
  }
}

export async function handleCardPrioritized(cardId: string, approval: MoveApproval): Promise<void> {
  const card = await getCard(cardId);
  const prior = readFreezeProjection(card.desc ?? "");
  if (prior?.state === "Active") {
    await commentOnCard(cardId, "ℹ️ This card already has an active Prioritized freeze; duplicate board events did not create another freeze.");
    return;
  }
  try {
    const resolved = await resolveSpecRequest(card, {
      githubApiBase: config.intentBacklogApiBase,
      githubToken: config.githubToken,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    });
    const tuple: FreezeTuple = {
      productId: resolved.productId,
      intentId: resolved.intentId,
      intentVersion: resolved.intentVersion,
      intentCommit: resolved.intentCommit,
      intentSha256: frozenArtifactSha256(resolved.frozenIntentBytes),
      policyProfileId: resolved.policyProfileId,
      policyProfileVersion: resolved.policyProfileVersion,
      policyProfileCommit: resolved.intentCommit,
      policyProfileSha256: resolved.policyProfileContentSha256,
      cardId,
      freezeEventId: approval.eventId,
      authorizedBy: approval.approvedBy,
      frozenAt: approval.approvedAt,
    };
    const freezeRecord = {
      schema_version: "1.0",
      event_id: approval.eventId ?? randomUUID(),
      event_type: "activated",
      work_item: { product_id: resolved.productId, intent_id: resolved.intentId, intent_version: resolved.intentVersion, trello_card_id: cardId },
      intent: { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.intentPath, sha256: frozenArtifactSha256(resolved.frozenIntentBytes) },
      policy_profile_id: resolved.policyProfileId,
      policy_profile_version: resolved.policyProfileVersion,
      policy_profile: { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.policyProfilePath, sha256: resolved.policyProfileContentSha256 },
      authorized_by: approval.approvedBy,
      recorded_at: approval.approvedAt,
    };
    const recordValidation = lifecycleValidator.validate("FreezeActivationEvent", freezeRecord);
    if (!recordValidation.valid) throw new Error(`FreezeActivationEvent is invalid: ${recordValidation.errors.join("; ")}`);
    const projection = { state: "Active" as const, tuple };
    await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", projection));
    await commentOnCard(cardId, `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze activation record.`);
    await commentOnCard(cardId, `🔒 Prioritized freeze activated.\n\n${JSON.stringify(projection, null, 2)}`);
  } catch (err) {
    const backlogId = await getListIdByName(config.listBacklog);
    await moveCard(cardId, backlogId);
    await commentOnCard(cardId, `⛔ Prioritized freeze was not activated; the card was returned to Backlog.\n\n${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleCardFreezeRevocation(cardId: string, revokedBy: string, revokedAt: string, eventId?: string): Promise<void> {
  const card = await getCard(cardId);
  const projection = readFreezeProjection(card.desc ?? "");
  if (!projection || projection.state !== "Active") return;
  if (!projection.tuple.freezeEventId) {
    await commentOnCard(cardId, "Freeze revocation was not recorded because the active freeze projection has no activation event ID.");
    return;
  }
  const freezeRecord = {
    schema_version: "1.0",
    event_id: eventId ?? randomUUID(),
    event_type: "revoked",
    work_item: { product_id: projection.tuple.productId, intent_id: projection.tuple.intentId, intent_version: projection.tuple.intentVersion, trello_card_id: cardId },
    revokes_event_id: projection.tuple.freezeEventId,
    authorized_by: revokedBy,
    recorded_at: revokedAt,
    reason: "The product owner returned the card to an editable pre-execution stage.",
  };
  const recordValidation = lifecycleValidator.validate("FreezeRevocationEvent", freezeRecord);
  if (!recordValidation.valid) {
    await commentOnCard(cardId, `Freeze revocation was not recorded because the event is invalid: ${recordValidation.errors.join("; ")}`);
    return;
  }
  const revoked = { ...projection, state: "Revoked" as const, revokedBy, revokedAt };
  await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", revoked));
  await commentOnCard(cardId, `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze revocation record.`);
  await commentOnCard(cardId, `🔓 Prioritized freeze revoked because the card returned to ${card.idList === await getListIdByName(config.listNewIdeas) ? "New Ideas" : "Backlog"}.\n\n${JSON.stringify(revoked, null, 2)}`);
}

export function handleCardReadyForAgent(cardId: string, acceptance: Record<string, unknown>, workspaceRef: string, targetCommit: string): void {
  enqueueCard({ cardId, acceptance, workspaceRef, targetCommit });
}

export function handleCardReviewForAgent(cardId: string): void {
  enqueueReview(cardId);
}

export function handleCardSpecAndDesign(cardId: string, approval: MoveApproval): void {
  enqueueSpec(cardId, approval);
}
