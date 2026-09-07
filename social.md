# Project journal

## 2026-09-04

The evaluator handoff is being changed from a local filesystem dependency to an immutable Git-revision handoff. The work is constrained to the orchestrator and evaluator repositories; the Coding Agent and MealFlow repositories remain untouched.

The host Node 24 test runner cannot start `tsx` because `uv_os_get_passwd` returns an ENOMEM error. The same suites run successfully in the Dockerized Node 20 runtime used by the evaluator.

## 2026-09-06

Added a third webhook trigger: a card entering **Spec & Design** now runs the
Spec & Design Agent. New modules `workflow/specRequestFromCard.ts` (card
projection + intent-backlog fetch + integrity check), `workflow/specWorkspace.ts`
(creates `work/<intent-id>` worktree, freezes `intent.md`, hashes it),
`specDesignAgent/runSpecDesignAgent.ts` (subprocess), `workflow/specRouting.ts`
(result → board move). `server.ts` and `workflow.ts` gained a parallel queue.

Decisions, all made to follow the agentic-sdlc docs:

- **Local subprocess**, not Docker or a NAS service — the deployment-boundary
  doc allows a local-process worker and it matches `runCodingAgent`.
- **Intent identity** comes from the card's metadata block
  (`work-tracking.md` "Trello card contract"); the **frozen bytes and hash**
  come from `intent-backlog` at the pinned `Intent Commit` via the GitHub
  contents API. Card↔backlog disagreement on id/product/version/status/hash is a
  hard stop with a card comment.
- **The orchestrator does the freeze** (worktree + staged `intent.md` +
  `frozenArtifactSha256`) so the hash precondition is checked Conductor-side
  before the agent runs. The agent re-verifies the bytes as its own gate.
- **`approval` is approximated**: `approvedAt` = frontmatter `frozen_at` or the
  move timestamp; `approvedBy` = the Trello member who moved the card. Flagged
  in the README as needing a real Ready-for-Planning capture later.
- **List names** `Spec & Design` / `Design Review` are env-overridable and
  resolved lazily, so a board without them still starts the existing flow.
- `SPEC_DESIGN_AGENT_CLI` is optional in config; unset → card comment, no crash.

Left alone: the coding/eval half still uses the retired board vocabulary and a
`TARGET_REPO`-committed intent. The two halves don't meet end to end yet — noted
in the README, out of scope here.

Pre-existing unrelated failure still red: `src/runtimeConfig.test.ts` asserts a
POSIX path and fails on Windows (`C:\workspace\...` vs `\workspace\...`). Not
touched.
