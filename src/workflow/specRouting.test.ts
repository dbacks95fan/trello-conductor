// ABOUTME: Unit tests for mapping a Spec & Design Agent result to a board destination and comment.
import assert from "node:assert/strict";
import test from "node:test";
import type { SpecDesignResult } from "../specDesignAgent/runSpecDesignAgent.js";
import { routeSpecResult } from "./specRouting.js";

function run(result: Record<string, unknown> | null, extra: Partial<SpecDesignResult> = {}): SpecDesignResult {
  return { exitCode: 0, result, rawStdout: "", rawStderr: "", ...extra };
}

test("spec_ready routes to Design Review and cites the committed spec", () => {
  const route = routeSpecResult(
    run({
      status: "spec_ready",
      summary: "Specification covers the weekly planner outcome.",
      branch: "work/INT-MF-0042",
      specPath: ".agent/work/INT-MF-0042/spec.md",
      specCommit: "f".repeat(40),
      specVersion: 1,
      nonBlockingConcerns: ["Nutrition targets are assumed, not specified."],
    }),
  );
  assert.equal(route.destination, "design-review");
  assert.match(route.comment, /ready for Design Review/i);
  assert.match(route.comment, /\.agent\/work\/INT-MF-0042\/spec\.md/);
  assert.match(route.comment, /Nutrition targets are assumed/);
  assert.match(route.comment, /performed by a human/i);
});

test("needs_decision routes to Human Decision Required with the itemised brief", () => {
  const route = routeSpecResult(
    run({
      status: "needs_decision",
      summary: "A storage boundary decision is required.",
      humanDecisions: [
        {
          question: "Which service owns meal-plan persistence?",
          impact: "Determines the affected bounded context and data model.",
          options: ["Reuse the recipe service", "Introduce a planner service"],
          minimumAuthority: "Product engineering lead",
        },
      ],
    }),
  );
  assert.equal(route.destination, "human-decision");
  assert.match(route.comment, /Which service owns meal-plan persistence\?/);
  assert.match(route.comment, /Reuse the recipe service/);
  assert.match(route.comment, /Product engineering lead/);
});

test("blocked keeps the card in place and lists blocking concerns", () => {
  const route = routeSpecResult(
    run({ status: "blocked", summary: "Frozen intent hash mismatch.", blockingConcerns: ["INTENT_MUTATED"] }),
  );
  assert.equal(route.destination, null);
  assert.match(route.comment, /blocked/i);
  assert.match(route.comment, /INTENT_MUTATED/);
});

test("failed keeps the card in place and explains retry", () => {
  const route = routeSpecResult(run({ status: "failed", summary: "Provider timeout." }, { exitCode: 30 }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /failed/i);
  assert.match(route.comment, /back into Spec & Design/);
});

test("an unparseable run keeps the card in place and quotes diagnostics", () => {
  const route = routeSpecResult(run(null, { exitCode: 1, rawStderr: "Traceback: boom" }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /no parseable result/i);
  assert.match(route.comment, /Traceback: boom/);
});

test("an unknown status is surfaced without moving the card", () => {
  const route = routeSpecResult(run({ status: "surprise", summary: "n/a" }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /unrecognised status/i);
});
