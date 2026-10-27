// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests the canonical board transition allowlist and owner decision gates.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveTransition } from "./transitionPolicy.js";
import type { WorkflowListIds } from "../trello/client.js";

const listIds: WorkflowListIds = {
  newIdeas: "list-1",
  backlog: "list-2",
  prioritized: "list-3",
  specDesign: "list-4",
  execution: "list-5",
  evaluation: "list-6",
  humanApproval: "list-7",
  release: "list-8",
  productionObservation: "list-9",
  done: "list-10",
};

test("resolves the documented happy path and owner-authorized transitions", () => {
  assert.equal(resolveTransition("list-2", "list-3", listIds).action, "activate_freeze");
  assert.equal(resolveTransition("list-2", "list-3", listIds).requiresProductOwner, true);
  assert.equal(resolveTransition("list-3", "list-4", listIds).action, "start_spec_design");
  assert.equal(resolveTransition("list-4", "list-5", listIds).action, "accept_spec");
  assert.equal(resolveTransition("list-7", "list-8", listIds).action, "human_approve_release");
});

test("blocks skipped and unknown list transitions while allowing pre-execution freeze revocation", () => {
  assert.equal(resolveTransition("list-2", "list-5", listIds).action, "invalid");
  assert.equal(resolveTransition("unknown", "list-5", listIds).action, "invalid");
  assert.equal(resolveTransition("list-4", "list-2", listIds).action, "revoke_freeze");
  assert.equal(resolveTransition("list-5", "list-2", listIds).action, "invalid");
});
