// ABOUTME: Maps a Spec & Design Agent result to a board destination and a human-readable decision brief.
import type { SpecDesignResult } from "../specDesignAgent/runSpecDesignAgent.js";

export type SpecDestination = "design-review" | "human-decision" | null;

export interface SpecRoute {
  destination: SpecDestination;
  comment: string;
}

function list(items: unknown, bullet = "-"): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((item) => `${bullet} ${String(item)}`).join("\n");
}

/** The Conductor owns the transition; this only decides which one and what to
 *  say. It never routes past Design Review — approval is always a human step. */
export function routeSpecResult(run: SpecDesignResult): SpecRoute {
  if (run.timedOut) {
    return {
      destination: null,
      comment:
        "⏱️ The Spec & Design Agent container exceeded its time budget and was killed. " +
        "The card stays in Spec & Design.\n\n```\n" +
        `${run.rawStderr.slice(-1000)}\n\`\`\``,
    };
  }

  if (!run.result) {
    return {
      destination: null,
      comment:
        `❌ Spec & Design Agent produced no parseable result (exit code ${run.exitCode ?? "none"}). ` +
        `Check that Docker is running and the \`spec-design-agent\` image is built on this host. ` +
        `The card stays in Spec & Design for investigation.\n\n\`\`\`\n${run.rawStderr.slice(-1500) || run.rawStdout.slice(-1500)}\n\`\`\``,
    };
  }

  const result = run.result;
  const status = String(result.status ?? "unknown");
  const summary = String(result.summary ?? "(no summary)");
  const nonBlocking = list(result.nonBlockingConcerns);

  if (status === "spec_ready") {
    const parts = [
      `✅ Spec & Design Agent finished: **spec ready for Design Review**.`,
      "",
      summary,
      "",
      `- Spec: \`${String(result.specPath ?? "(path missing)")}\` (v${String(result.specVersion ?? "?")})`,
      `- Spec commit: \`${String(result.specCommit ?? "(missing)")}\` on \`${String(result.branch ?? "?")}\``,
    ];
    if (nonBlocking) parts.push("", "**For the reviewer's attention**", nonBlocking);
    parts.push(
      "",
      "Design Review is performed by a human. A successful result means *ready for review*, not approved.",
    );
    return { destination: "design-review", comment: parts.join("\n") };
  }

  if (status === "needs_decision") {
    const decisions = Array.isArray(result.humanDecisions) ? (result.humanDecisions as Array<Record<string, unknown>>) : [];
    const rendered = decisions
      .map((decision, index) => {
        const lines = [
          `**Decision ${index + 1}: ${String(decision.question ?? "(question missing)")}**`,
          `- Impact: ${String(decision.impact ?? "not stated")}`,
          `- Minimum authority: ${String(decision.minimumAuthority ?? "not stated")}`,
        ];
        const options = list(decision.options);
        if (options) lines.push(`- Options:\n${options.replace(/^/gm, "  ")}`);
        return lines.join("\n");
      })
      .join("\n\n");
    return {
      destination: "human-decision",
      comment: [
        `⏸️ Spec & Design Agent needs a human decision before a specification can be written.`,
        "",
        summary,
        "",
        rendered || "_The agent reported needs_decision without an itemised decision._",
      ].join("\n"),
    };
  }

  if (status === "blocked") {
    return {
      destination: null,
      comment: [
        `⛔ Spec & Design is blocked by a precondition (input, integrity, access, or environment).`,
        "",
        summary,
        list(result.blockingConcerns) ? `\n**Blocking concerns**\n${list(result.blockingConcerns)}` : "",
        "\nThe card stays in Spec & Design. Resolve the blocker, then move it out and back in to retry.",
      ].join("\n"),
    };
  }

  if (status === "failed") {
    return {
      destination: null,
      comment: [
        `❌ Spec & Design Agent failed unexpectedly (exit code ${run.exitCode ?? "none"}).`,
        "",
        summary,
        "\nAutomatic retry is not enabled in v0.1. Move the card out of and back into Spec & Design to retry.",
      ].join("\n"),
    };
  }

  return {
    destination: null,
    comment: `⚠️ Spec & Design Agent returned an unrecognised status \`${status}\`. The card stays in Spec & Design.\n\n${summary}`,
  };
}
