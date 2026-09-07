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

Later the same day: the Spec & Design Agent must run as a Docker container
deployed to this machine, not as a local subprocess. Two consequences worth
recording, because the second one forced a rewrite:

- `runSpecDesignAgent.ts` now shells `docker run --rm` with the workspace
  bind-mounted at `/work`, replicating the hardening in the agent's own
  `compose.yaml` (read-only rootfs, tmpfs `/tmp`, `HOME=/tmp`, `cap-drop ALL`,
  `no-new-privileges`). `SPEC_DESIGN_AGENT_IMAGE` replaces the CLI command; the
  orchestrator never builds the image. Added a hard timeout that kills the run.
- **`git worktree` cannot work here.** A worktree's `.git` is a link file
  holding an absolute host path into the parent repo's `.git/worktrees/`, which
  does not resolve inside the container — and mounting the parent repo would not
  fix it, because a Windows host path is meaningless to a Linux container.
  `specWorkspace.ts` now makes a full local clone instead: self-contained `.git`,
  all history so `baseCommit` is verifiable offline, and `origin` removed since
  it points at an unreachable host path. This replaced yesterday's worktree
  implementation rather than patching it — the constraint changed, not the code.

`target.workspace` in the request is `/work`, not the host path: the agent
resolves it from inside the container. The request file is written into the
workspace as `spec-design-request.json` and removed after the run.

Tests use a `fake-docker.cjs` fixture standing in for the docker CLI, so unit,
integration, and e2e stay hermetic and offline. A real-daemon run against the
built image is still a deployment-verification step, not something the suite
covers.

Probed the flag set against the real daemon rather than trusting it, and caught
a defect the hermetic tests could never have found: git aborts with **"detected
dubious ownership in repository at '/work'"** when the container's non-root uid
does not own the bind-mounted files. The agent would have died at its first
workspace check, every time. Fixed by passing `safe.directory=/work` plus a
commit identity through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
`GIT_CONFIG_VALUE_n`, which needs neither a writable HOME nor a writable rootfs.
Re-verified against the daemon: status, branch resolution, staging, commit, and
author identity all work under `--read-only` as uid 10001.

Also dropped a redundant `--workdir /app` — the image already sets it. (It first
showed up as a bogus `C:/Program Files/Git/app` because Git Bash rewrote the
path in my manual probe; Node's `spawn` does no such conversion, so it was never
a product bug, just a misleading test artifact.)
