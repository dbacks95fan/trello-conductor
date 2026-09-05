// ABOUTME: Defines unit tests for the immutable Git handoff sent to the remote evaluator.
import assert from "node:assert/strict";
import test from "node:test";
import { runRemoteEvaluator } from "./remote.js";

test("sends only immutable Git handoff metadata with bearer authentication", async () => {
  let request: Request | undefined;
  const result = await runRemoteEvaluator({
    endpoint: "http://evaluator.test/evaluations",
    token: "test-token",
    repositoryUrl: "https://github.com/example/candidate.git",
    revision: "a".repeat(40),
    workItem: "remote-evaluator-git-handoff",
    intentPath: ".agent/work/remote-evaluator-git-handoff/intent.md",
    contractPath: ".agent/work/remote-evaluator-git-handoff/contract.yaml",
    evidencePath: ".agent/evidence/remote-evaluator-git-handoff-run.json",
  }, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ status: "pass", summary: "Verified" }), { status: 200 });
  });

  assert.equal(request?.headers.get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(await request!.text()), {
    repositoryUrl: "https://github.com/example/candidate.git",
    revision: "a".repeat(40),
    workItem: "remote-evaluator-git-handoff",
    intentPath: ".agent/work/remote-evaluator-git-handoff/intent.md",
    contractPath: ".agent/work/remote-evaluator-git-handoff/contract.yaml",
    evidencePath: ".agent/evidence/remote-evaluator-git-handoff-run.json",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.evaluation?.status, "pass");
});
