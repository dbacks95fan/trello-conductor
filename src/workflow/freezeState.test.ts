// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies that the card's current freeze projection is replaceable and fails closed.

import assert from "node:assert/strict";
import test from "node:test";
import { activeFreezeForCard, readFreezeProjection, writeFreezeProjection, type FreezeTuple } from "./freezeState.js";
import type { TrelloCard } from "../trello/client.js";

const tuple: FreezeTuple = {
  productId: "MF",
  intentId: "INT-MF-0042",
  intentVersion: 3,
  intentCommit: "a".repeat(40),
  intentSha256: "b".repeat(64),
  policyProfileId: "MF-DEFAULT",
  policyProfileVersion: "1",
  policyProfileCommit: "a".repeat(40),
  policyProfileSha256: "c".repeat(64),
  cardId: "card-1",
  authorizedBy: "Product Owner",
  frozenAt: "2026-10-07T12:00:00.000Z",
};

function card(desc: string, id = "card-1"): TrelloCard {
  return { id, idShort: 1, name: "Test", desc, idList: "list", shortLink: "test", url: "https://trello.com/c/test" };
}

test("freeze projection preserves the card description and records active state", () => {
  const desc = writeFreezeProjection("Problem statement", { state: "Active", tuple });
  assert.match(desc, /^Problem statement/);
  assert.equal(readFreezeProjection(desc)?.state, "Active");
  assert.equal(activeFreezeForCard(card(desc))?.tuple.intentSha256, tuple.intentSha256);
});

test("freeze projection can be revoked without losing the original tuple", () => {
  const active = { state: "Active" as const, tuple };
  const desc = writeFreezeProjection(writeFreezeProjection("Card", active), {
    ...active,
    state: "Revoked",
    revokedAt: "2026-10-07T13:00:00.000Z",
  });
  assert.equal(readFreezeProjection(desc)?.state, "Revoked");
  assert.equal(readFreezeProjection(desc)?.tuple.intentCommit, tuple.intentCommit);
  assert.equal(activeFreezeForCard(card(desc)), null);
});

test("malformed or cross-card freeze projections fail closed", () => {
  assert.equal(readFreezeProjection("<!-- agentic-sdlc-freeze-state {bad} -->"), null);
  const desc = writeFreezeProjection("", { state: "Active", tuple });
  assert.equal(activeFreezeForCard(card(desc, "other-card")), null);
});
