# Intent: Evaluate Trello candidates from their Git revision

## Identity
- **Work ID:** remote-evaluator-git-handoff
- **Status:** Accepted
- **Source:** Sobe’s request to confirm and enable Trello-triggered evaluation, with the explicit direction that all evaluation files live in the Git branch.
- **Visualization board:** MealFlow Trello board
- **Root work item:** Pending creation during the controlled board test

## Problem
When a card enters Agent Review, the local orchestrator can only invoke a local evaluator CLI. The NAS-hosted evaluator cannot inspect the local candidate worktree, contract, intent, or evidence. Trello also currently has no registered webhook for the configured board.

## Desired outcome
Moving an eligible card into Agent Review causes the orchestrator to evaluate the exact, pushed Git revision through the authenticated NAS evaluator, without copying candidate files to persistent NAS storage.

## Evidence of success
- Trello has an active webhook for the configured board and callback URL.
- The orchestrator records the candidate branch’s immutable commit SHA before starting evaluation.
- The evaluator checks out that SHA into request-scoped temporary storage, returns a result, and removes the checkout.
- A controlled Trello card transition produces visible evaluator-started and evaluator-result comments.

## Constraints
- Candidate source, intent, Work Contract, and evidence must be committed to the candidate Git branch.
- The evaluator container remains stateless and must not retain repository or job artifacts after a request completes.
- The orchestrator owns Trello writes and evaluator result handling.
- The Coding Agent and MealFlow repositories are out of scope for modification.

## Assumptions
- The candidate repository’s remote is reachable from the NAS evaluator with configured read access. This must be verified during deployment.
- The orchestrator has authority to push the candidate branch after the Coding Agent reports `candidate_complete`.

## Recommended direction
Use Git as the handoff artifact store. The orchestrator verifies and pushes the candidate branch, then calls the evaluator with an authenticated request containing the repository URL, immutable revision, and repository-relative artifact paths. The evaluator checks out that revision in temporary storage and evaluates it.

## Priority profile
- **Importance:** 8/12
- **Priority band:** P1 High
- **Outcome value:** 3/4 — Enables independently verifiable, remote evaluation in the delivery workflow.
- **Time criticality:** 2/4 — Blocks the requested end-to-end workflow confirmation, but no fixed external deadline is known.
- **Risk reduction / opportunity enablement:** 3/4 — Replaces an unproven local-only integration with traceable, immutable handoff artifacts.
- **Review attention:** Review Now — The workflow crosses Trello, GitHub, and the NAS evaluator.
- **Evidence confidence:** High — Confirmed from the current orchestrator and evaluator implementations.
- **Relative job size:** 5
- **Sequencing score:** 1.6
- **Ready state:** Ready

## User story

### Evaluate an agent candidate from Git
**Intent:** Give Sobe a visible, trustworthy evaluation workflow when a Trello card enters Agent Review.

**Story:** As a delivery reviewer, I want the evaluator to inspect the exact candidate revision stored in Git, so that the board reflects an independent result that can be traced to immutable artifacts.

**Acceptance criteria:**
- The orchestrator pushes a clean candidate branch and records its commit SHA before requesting evaluation.
- The evaluator accepts only an authenticated request for an allowed Git repository and checks out the requested SHA into temporary storage.
- The evaluator removes the temporary checkout after completing or failing the run.
- A card moved into Agent Review receives clear start and result comments.
- The orchestrator’s unit, integration, and end-to-end tests cover the handoff path.

## Handoff
- **Next stage:** Implementation and controlled end-to-end validation
- **Canonical path:** `.agent/work/remote-evaluator-git-handoff/intent.md`
- **Review URL:** Pending push
