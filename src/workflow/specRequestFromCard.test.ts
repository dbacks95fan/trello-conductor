// ABOUTME: Unit tests for resolving and integrity-checking a Spec & Design request from a Trello card.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { TrelloCard } from "../trello/client.js";
import {
  frozenArtifactSha256,
  parseCanonicalIntentUrl,
  parseCardIntentMetadata,
  resolveSpecRequest,
  SpecRequestError,
} from "./specRequestFromCard.js";

const COMMIT = "a".repeat(40);
const PATH = "products/mealflow/intents/INT-MF-0042/intent.md";
const CANONICAL = `https://github.com/dbacks95fan/intent-backlog/blob/${COMMIT}/${PATH}`;

function intentMarkdown(overrides: Record<string, string> = {}): string {
  const fm: Record<string, string> = {
    intent_id: "INT-MF-0042",
    product_id: "MF",
    product_name: "MealFlow",
    trello_card_id: "card-long-id",
    intent_version: "3",
    status: "Frozen",
    intent_commit: COMMIT,
    intent_hash: `sha256:${"d".repeat(64)}`,
    frozen_at: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
  return "---\n" + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n# Intent: Meal planner\n";
}

function card(desc: string): TrelloCard {
  return {
    id: "card-long-id",
    idShort: 42,
    name: "[Feature] Weekly meal planner",
    desc,
    idList: "list-1",
    shortLink: "abc123",
    url: "https://trello.com/c/abc123/42-weekly-meal-planner",
  };
}

function description(overrides: Record<string, string> = {}): string {
  const lines: Record<string, string> = {
    Product: "MealFlow (MF)",
    "Intent ID": "INT-MF-0042",
    "Intent Version": "3",
    "Intent Commit": COMMIT,
    "Intent Hash": `sha256:${"d".repeat(64)}`,
    "Intent Status": "Frozen",
    "Canonical intent": CANONICAL,
    ...overrides,
  };
  return [
    ...Object.entries(lines).map(([k, v]) => `${k}: ${v}`),
    "",
    "## Problem",
    "Planning meals weekly is tedious.",
  ].join("\n");
}

function stubFetch(body: string, init: ResponseInit = { status: 200 }): typeof fetch {
  return (async () => new Response(body, init)) as typeof fetch;
}

const baseOptions = {
  githubApiBase: "https://api.github.com",
  githubToken: "",
  approvedBy: "Sobe",
  approvedAt: "2026-09-06T09:00:00.000Z",
};

test("parseCardIntentMetadata reads the Intent Creation Skill card projection", () => {
  const meta = parseCardIntentMetadata(card(description()));
  assert.equal(meta.productId, "MF");
  assert.equal(meta.intentId, "INT-MF-0042");
  assert.equal(meta.intentVersion, 3);
  assert.equal(meta.intentCommit, COMMIT);
  assert.equal(meta.intentContentSha256, "d".repeat(64));
  assert.equal(meta.intentStatus, "Frozen");
});

test("parseCardIntentMetadata tolerates markdown bold labels and bullets", () => {
  const desc = description().replace("Intent ID: INT-MF-0042", "- **Intent ID:** INT-MF-0042");
  assert.equal(parseCardIntentMetadata(card(desc)).intentId, "INT-MF-0042");
});

test("parseCardIntentMetadata rejects a card missing projected metadata", () => {
  const desc = description().split("\n").filter((line) => !line.startsWith("Intent ID:")).join("\n");
  assert.throws(() => parseCardIntentMetadata(card(desc)), (err: Error) => err instanceof SpecRequestError && /Intent ID/.test(err.message));
});

test("parseCardIntentMetadata rejects an intent that is not frozen", () => {
  assert.throws(
    () => parseCardIntentMetadata(card(description({ "Intent Status": "Accepted" }))),
    (err: Error) => err instanceof SpecRequestError && /Frozen/.test(err.message),
  );
});

test("parseCardIntentMetadata rejects a malformed commit or hash", () => {
  assert.throws(() => parseCardIntentMetadata(card(description({ "Intent Commit": "abc123" }))), SpecRequestError);
  assert.throws(() => parseCardIntentMetadata(card(description({ "Intent Hash": "not-a-hash" }))), SpecRequestError);
});

test("parseCanonicalIntentUrl accepts blob, raw, and API URLs", () => {
  assert.deepEqual(parseCanonicalIntentUrl(CANONICAL), { owner: "dbacks95fan", repo: "intent-backlog", path: PATH });
  assert.deepEqual(
    parseCanonicalIntentUrl(`https://raw.githubusercontent.com/dbacks95fan/intent-backlog/${COMMIT}/${PATH}`),
    { owner: "dbacks95fan", repo: "intent-backlog", path: PATH },
  );
  assert.deepEqual(
    parseCanonicalIntentUrl(`https://api.github.com/repos/dbacks95fan/intent-backlog/contents/${PATH}?ref=${COMMIT}`),
    { owner: "dbacks95fan", repo: "intent-backlog", path: PATH },
  );
  assert.throws(() => parseCanonicalIntentUrl("https://example.com/x"), SpecRequestError);
});

test("resolveSpecRequest returns a request grounded in the fetched frozen intent", async () => {
  const markdown = intentMarkdown();
  const resolved = await resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch(markdown) });

  assert.equal(resolved.intentId, "INT-MF-0042");
  assert.equal(resolved.productId, "MF");
  assert.equal(resolved.intentRepository, "dbacks95fan/intent-backlog");
  assert.equal(resolved.intentPath, PATH);
  assert.equal(resolved.intentContentSha256, "d".repeat(64));
  assert.deepEqual(resolved.frozenIntentBytes, Buffer.from(markdown));
  assert.equal(frozenArtifactSha256(resolved.frozenIntentBytes), createHash("sha256").update(markdown).digest("hex"));
  // frozen_at from the artifact wins over the Trello move timestamp
  assert.equal(resolved.approvedAt, "2026-08-01T12:00:00.000Z");
  assert.equal(resolved.approvedBy, "Sobe");
  assert.deepEqual(resolved.warnings, []);
});

test("resolveSpecRequest sends bearer auth and pins the ref to the card commit", async () => {
  let seenUrl = "";
  let seenAuth: string | null = null;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = new Headers(init.headers).get("authorization");
    return new Response(intentMarkdown());
  }) as unknown as typeof fetch;

  await resolveSpecRequest(card(description()), { ...baseOptions, githubToken: "ghp_x", fetchFn });
  assert.match(seenUrl, /\/repos\/dbacks95fan\/intent-backlog\/contents\/products\/mealflow\/intents\/INT-MF-0042\/intent\.md\?ref=a{40}$/);
  assert.equal(seenAuth, "Bearer ghp_x");
});

test("resolveSpecRequest fails when the card and the canonical intent disagree", async () => {
  await assert.rejects(
    resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch(intentMarkdown({ intent_id: "INT-MF-9999" })) }),
    (err: Error) => err instanceof SpecRequestError && /disagree/.test(err.message) && /intent_id/.test(err.message),
  );

  await assert.rejects(
    resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch(intentMarkdown({ intent_hash: `sha256:${"e".repeat(64)}` })) }),
    (err: Error) => err instanceof SpecRequestError && /intent_hash/.test(err.message),
  );
});

test("resolveSpecRequest warns but proceeds on a self-referential commit field", async () => {
  const resolved = await resolveSpecRequest(card(description()), {
    ...baseOptions,
    fetchFn: stubFetch(intentMarkdown({ intent_commit: "b".repeat(40) })),
  });
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /intent_commit/);
});

test("resolveSpecRequest surfaces a GitHub fetch failure as a SpecRequestError", async () => {
  await assert.rejects(
    resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch("Not Found", { status: 404 }) }),
    (err: Error) => err instanceof SpecRequestError && /HTTP 404/.test(err.message) && /GITHUB_TOKEN/.test(err.message),
  );
});
