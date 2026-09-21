// ABOUTME: Verifies board provisioning uses Trello's full board identifier for list creation.
import assert from "node:assert/strict";
import test from "node:test";

test("creates a list with the resolved full board identifier", async () => {
  Object.assign(process.env, {
    TRELLO_API_KEY: "test-key",
    TRELLO_TOKEN: "test-token",
    TRELLO_API_SECRET: "test-secret",
    TRELLO_BOARD_ID: "short-board-id",
    TARGET_REPO: "C:/Repos/PerioVox",
    CODING_AGENT_CLI: "C:/Repos/coding-agent/dist/cli.js",
    EVALUATOR_API_URL: "http://127.0.0.1:8080",
    EVALUATOR_API_TOKEN: "test-evaluator-token",
    CALLBACK_URL: "https://example.test",
  });

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/boards/short-board-id")) {
      return Response.json({ id: "0123456789abcdef01234567" });
    }
    return Response.json({ id: "list-1", name: "New Ideas", pos: 1 });
  };

  try {
    const { createList } = await import("./client.js");
    await createList("New Ideas");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.match(requests[1], /idBoard=0123456789abcdef01234567/);
});
