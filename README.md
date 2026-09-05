# Trello Conductor (v0.1)

Trello-webhook-driven orchestrator for the experimental Agentic SDLC. Watches
one Trello list ("Ready for Agent"), and when a card moves into it: validates
the event came from Trello, builds a Work Contract from the card, enforces a
WIP limit, invokes the [coding-agent](https://github.com/dbacks95fan/coding-agent)
CLI, and updates the card's list + comments based on the result.

Trello Conductor — not Claude — owns all Trello reads and writes. It calls the
Trello REST API directly with a key/token/secret; the Coding Agent it invokes
has no Trello access at all.

The evaluator runs remotely on the NAS. When a candidate is complete, Trello
Conductor verifies the candidate branch is clean, commits the Work Contract and
evidence to that branch, pushes it, and records the immutable commit SHA in the
card handoff comment. When the card enters Agent Review, the Evaluator checks
out that SHA into temporary container storage, evaluates it, and removes the
checkout before responding.

## Structure

```
src/
├── server.ts                    Express app: webhook endpoint, startup/registration
├── config.ts                    env var loading + the shared webhookUrl constant
├── trello/
│   ├── client.ts                thin Trello REST API wrapper (lists, cards, comments, webhooks)
│   └── webhookVerify.ts         HMAC signature check on incoming deliveries
├── workflow/
│   ├── workflow.ts              the queue + per-card state machine
│   ├── wip.ts                   WIP limit check against TRELLO_LIST_WORKING
│   └── contractFromCard.ts      deterministic card-description -> Work Contract parser
└── codingAgent/
    └── runCodingAgent.ts        spawns the coding-agent CLI as a subprocess
```

Grouped by concern rather than kept flat: `trello/` is everything that talks to
Trello's API, `workflow/` is the orchestration logic that doesn't care which
task-tracker it came from, `codingAgent/` is the one integration point with the
tool it invokes.

## What it does, step by step

1. Trello POSTs an `updateCard` webhook event whenever anything on the board
   changes.
2. `src/trello/webhookVerify.ts` checks the `X-Trello-Webhook` HMAC signature
   against the raw request body — deliveries that don't verify are rejected
   with 401 and never reach the workflow logic.
3. If the event says a card moved into `TRELLO_LIST_READY`, the card is queued
   (`src/workflow/workflow.ts`).
4. The queue drains one card at a time, gated by `WIP_LIMIT` cards currently in
   `TRELLO_LIST_WORKING` (`src/workflow/wip.ts`) — if full, the card waits in
   memory and is picked up as soon as a slot frees.
5. `src/workflow/contractFromCard.ts` deterministically parses the card's
   description (the USER STORY / ACCEPTANCE CRITERIA / PLAYWRIGHT (TEST CASES) /
   DONE (DEFINITION OF DONE) convention used on this board, with some heading
   aliases tolerated) into a Work Contract. This is pattern-matching, not
   judgment — if the expected structure isn't there, it throws rather than
   inventing acceptance criteria, and the card is left in place with a comment
   explaining what's missing.
6. The card moves to `TRELLO_LIST_WORKING`, and
   `src/codingAgent/runCodingAgent.ts` spawns
   `coding-agent run --contract <generated.yaml> --repo <TARGET_REPO>` exactly
   as documented in that tool's own README — no special integration.
7. For a `candidate_complete` result, Trello Conductor records the Work Contract
   and Evidence Package in the candidate branch, pushes the branch, and writes
   the repository URL, commit SHA, and repository-relative artifact paths to
   the evaluator handoff comment.
8. When the card enters `TRELLO_LIST_REVIEW`, Trello Conductor calls the
   authenticated `EVALUATOR_API_URL` endpoint. The evaluator validates the
   allowed repository URL, checks out the supplied SHA into request-scoped
   temporary storage, and returns its JSON result.
9. Whatever the result (`candidate_complete`, `blocked`, `needs_decision`,
   `failed`, or no parseable output at all), the card moves to
   `TRELLO_LIST_REVIEW` with a comment summarizing the outcome and validation
   gate results. **Trello Conductor never moves a card to Done** — that's a
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

Set `EVALUATOR_API_URL` to the NAS evaluator address and `EVALUATOR_API_TOKEN`
to the same bearer token configured by the evaluator. Store the bearer token in
the shared workspace `C:\Repos\.config\agentic-sdlc\runtime.env` file, not in a
repository. Set `ORCHESTRATOR_SECRETS_FILE` only if you use another location.
The evaluator deployment
must set `EVALUATOR_ALLOWED_REPOSITORY_URL` to the candidate repository’s HTTPS
`origin` URL. If that repository is private, configure a read-only GitHub
credential in the NAS runtime environment. Do not store credentials in this
repository.

## Known limitations (v0.1, on purpose)

- **Quick tunnels are ephemeral.** Restarting `cloudflared` gives a new URL,
  which means a new webhook registration — the old one is left dangling on
  Trello (harmless, just unused) until manually cleaned up. A named tunnel with
  a real domain would fix this; out of scope for now.
- **The WIP queue is in-memory only.** A card sitting in `Ready for Agent`
  when Trello Conductor restarts will not be picked up automatically — move
  it out and back into the list to re-trigger the webhook, or wait for a
  future periodic-sweep fallback (not built yet).
- **The card-description parser is deliberately non-judgmental, not
  general-purpose.** It tolerates a handful of known heading aliases (see
  `SECTION_ALIASES` in `contractFromCard.ts`) and refuses to let an
  unrecognized heading's content leak into a recognized section, but it is
  still pattern-matching, not the Codex Planner — a genuinely novel section
  structure will fail loudly rather than being silently misparsed or guessed
  at.
