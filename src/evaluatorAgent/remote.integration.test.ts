// ABOUTME: Verifies the remote evaluator handoff across a real local HTTP boundary.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runRemoteEvaluator } from "./remote.js";

test("sends an authenticated Git revision handoff to an evaluator HTTP endpoint", async () => {
  let authorization = "";
  let body = "";
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? "";
    for await (const chunk of request) body += String(chunk);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(JSON.stringify({ status: "pass", summary: "Remote evaluator completed the Git revision." })));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not provide a TCP address");
  try {
    const result = await runRemoteEvaluator({
      endpoint: `http://127.0.0.1:${address.port}/evaluations`,
      token: "integration-token",
      repositoryUrl: "https://github.com/example/candidate.git",
      revision: "b".repeat(40),
      workItem: "integration-work-item",
      intentPath: ".agent/work/integration-work-item/intent.md",
      contractPath: ".agent/work/integration-work-item/contract.yaml",
      evidencePath: ".agent/evidence/integration-work-item.json",
    });
    assert.equal(authorization, "Bearer integration-token");
    assert.equal(JSON.parse(body).revision, "b".repeat(40));
    assert.equal(result.evaluation?.status, "pass");
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
});
