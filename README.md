# Trello Conductor (v0.1)

Trello-webhook-driven orchestrator for the experimental Agentic SDLC. It
validates that each webhook delivery came from Trello, then reacts to a card
entering one of three lists:

| Card enters | Conductor runs | On success moves to |
| --- | --- | --- |
| **Spec & Design** | [spec-design-agent](https://github.com/dbacks95fan/spec-design-agent) (frozen intent → `spec.md`) | Design Review |
| **Ready for Agent** | [coding-agent](https://github.com/dbacks95fan/coding-agent) (Work Contract → candidate) | Agent Review |
| **Agent Review** | the NAS Evaluator (candidate Git revision → structured result) | Human Approval / Human Decision Required |

Stage names follow the canonical lifecycle vocabulary in
[`agentic-sdlc/docs/WORKFLOW.md`](https://github.com/dbacks95fan/agentic-sdlc/blob/main/docs/WORKFLOW.md).
Trello Conductor — not an agent — owns every Trello read and write. It never
moves a card to Done and never records an approval.

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
│   ├── workflow.ts              the queues + per-card state machines
│   ├── wip.ts                   WIP limit check against TRELLO_LIST_WORKING
│   ├── contractFromCard.ts      deterministic card-description -> Work Contract parser
│   ├── specRequestFromCard.ts   card metadata + intent-backlog fetch -> Spec & Design request
│   ├── specWorkspace.ts         creates work/<intent-id> worktree, freezes intent.md into it
│   └── specRouting.ts           Spec & Design result -> board destination + decision brief
├── codingAgent/
│   └── runCodingAgent.ts        spawns the coding-agent CLI as a subprocess
├── specDesignAgent/
│   └── runSpecDesignAgent.ts    spawns the spec-design-agent bounded job as a subprocess
└── evaluatorAgent/
    ├── gitHandoff.ts            commits + pushes immutable evaluator artifacts
    └── remote.ts                authenticated request to the NAS Evaluator
```

Grouped by concern rather than kept flat: `trello/` is everything that talks to
Trello's API, `workflow/` is the orchestration logic that doesn't care which
task-tracker it came from, and each `*Agent/` directory is one integration
point with a tool it invokes.

## Spec & Design trigger

When a card enters `TRELLO_LIST_SPEC_DESIGN` the orchestrator acts as the first
engineering-stage handler for that work item:

1. It reads the intent projection the Intent Creation Skill writes onto the card
   description — `Product`, `Intent ID`, `Intent Version`, `Intent Commit`,
   `Intent Hash`, `Intent Status`, `Canonical intent`
   (`src/workflow/specRequestFromCard.ts`). `Intent Status` must be `Frozen`.
2. It fetches the exact `intent.md` bytes from the `intent-backlog` repository at
   the pinned `Intent Commit` through the GitHub contents API, and refuses to
   continue if the card projection and the canonical frontmatter disagree on
   `intent_id`, `product_id`, `intent_version`, `status`, or `intent_hash`.
3. It creates the isolated `work/<intent-id>` worktree in `TARGET_REPO` off the
   current default-branch HEAD, writes the frozen bytes to
   `.agent/work/<intent-id>/intent.md`, commits them on the work branch, and
   computes their raw-byte `frozenArtifactSha256` (`src/workflow/specWorkspace.ts`).
4. It builds a request per `spec-design-agent/schemas/spec-request.schema.json`
   (`runId`, `workItem`, `productId`, `intent`, `target`, `approval`) and spawns
   the Spec & Design Agent as a bounded subprocess:
   `<SPEC_DESIGN_AGENT_CLI> spec --request <file> --provider <provider>`.
5. It routes on the agent's result (`src/workflow/specRouting.ts`):
   `spec_ready` → move to `TRELLO_LIST_DESIGN_REVIEW` with a decision brief;
   `needs_decision` → move to `TRELLO_LIST_HUMAN_DECISION` with the itemised
   decisions; `blocked` / `failed` / unparseable → leave the card in place with
   a comment. Design Review is a human step; the orchestrator never approves it.

**`approval` is a v0.1 approximation.** `approvedAt` is the intent's `frozen_at`
when the frontmatter carries it, otherwise the timestamp of the move into Spec &
Design; `approvedBy` is the Trello member who moved the card. A dedicated
Ready-for-Planning capture would supply these directly.

**This half follows the canonical model** (intent-backlog repo, `Frozen` status,
`INT-<PRODUCT>-NNNN` work items, `work/<intent-id>` branch). The existing coding
and evaluation triggers still use the older board vocabulary and derive
`TRELLO-<idShort>` work items from an intent committed in `TARGET_REPO`; the two
halves do not yet meet end to end.

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

For the Spec & Design trigger, set `SPEC_DESIGN_AGENT_CLI` to the command that
runs the [spec-design-agent](https://github.com/dbacks95fan/spec-design-agent)
bounded job (see `.env.example`), and put a `GITHUB_TOKEN` with read access to
the private `intent-backlog` repository in the same shared runtime file. Add the
`Spec & Design` and `Design Review` lists to the board (or point
`TRELLO_LIST_SPEC_DESIGN` / `TRELLO_LIST_DESIGN_REVIEW` at your names). Until
`SPEC_DESIGN_AGENT_CLI` is set, a card entering Spec & Design gets an
explanatory card comment and stays put; the coding and evaluation triggers are
unaffected.

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
