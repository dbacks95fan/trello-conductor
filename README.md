# orchestrator (v0.1)

Trello-webhook-driven Orchestrator for the experimental Agentic SDLC. Watches one
Trello list ("Ready for Agent"), and when a card moves into it: validates the
event came from Trello, builds a Work Contract from the card, enforces a WIP
limit, invokes the [coding-agent](https://github.com/dbacks95fan/coding-agent)
CLI, and updates the card's list + comments based on the result.

The orchestrator — not Claude — owns all Trello reads and writes. It calls the
Trello REST API directly with a key/token/secret; the Coding Agent it invokes
has no Trello access at all.

## What it does, step by step

1. Trello POSTs an `updateCard` webhook event whenever anything on the board
   changes.
2. `src/webhookVerify.ts` checks the `X-Trello-Webhook` HMAC signature against
   the raw request body — deliveries that don't verify are rejected with 401
   and never reach the workflow logic.
3. If the event says a card moved into `TRELLO_LIST_READY`, the card is queued
   (`src/workflow.ts`).
4. The queue drains one card at a time, gated by `WIP_LIMIT` cards currently in
   `TRELLO_LIST_WORKING` (`src/wip.ts`) — if full, the card waits in memory and
   is picked up as soon as a slot frees.
5. `src/contractFromCard.ts` deterministically parses the card's description
   (the USER STORY / ACCEPTANCE CRITERIA / PLAYWRIGHT TEST CASES / DEFINITION OF
   DONE convention already used on this board) into a Work Contract. This is
   pattern-matching, not judgment — if the expected structure isn't there, it
   throws rather than inventing acceptance criteria, and the card is left in
   place with a comment explaining what's missing.
6. The card moves to `TRELLO_LIST_WORKING`, and `src/runCodingAgent.ts` spawns
   `coding-agent run --contract <generated.yaml> --repo <TARGET_REPO>` exactly
   as documented in that tool's own README — no special integration.
7. Whatever the result (`candidate_complete`, `blocked`, `needs_decision`,
   `failed`, or no parseable output at all), the card moves to
   `TRELLO_LIST_REVIEW` with a comment summarizing the outcome and validation
   gate results. **The orchestrator never moves a card to Done** — that's a
   human decision, always.

## Setup

```
npm install
npm run build
cp .env.example .env   # fill in TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_API_SECRET, CALLBACK_URL
```

You need a public HTTPS URL for `CALLBACK_URL` before starting — Trello's
webhook API cannot call a LAN-only address. A Cloudflare quick tunnel is the
fastest way to get one with no account/domain required:

```
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://<random>.trycloudflare.com` URL it prints into `.env` as
`CALLBACK_URL` (with `/webhooks/trello` NOT appended — the server adds that
path itself when registering the webhook), then:

```
npm start
```

On startup it resolves the board's real id, and calls Trello's webhook API to
create (or reuse, if one already exists for this exact callback URL) the
subscription — idempotent, safe to restart.

## Known limitations (v0.1, on purpose)

- **Quick tunnels are ephemeral.** Restarting `cloudflared` gives a new URL,
  which means a new webhook registration — the old one is left dangling on
  Trello (harmless, just unused) until manually cleaned up. A named tunnel with
  a real domain would fix this; out of scope for now.
- **The WIP queue is in-memory only.** A card sitting in `Ready for Agent`
  when the orchestrator restarts will not be picked up automatically — move it
  out and back into the list to re-trigger the webhook, or wait for a future
  periodic-sweep fallback (not built yet).
- **The card-description parser is intentionally rigid.** It expects the exact
  section-heading convention already used on this board. It is not the Codex
  Planner — it does not use judgment, only pattern-matches structure a human
  already wrote.
