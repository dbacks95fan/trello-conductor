// ABOUTME: Verifies the stable workspace location used for non-repository runtime secrets.
import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { defaultRuntimeSecretsFile } from "./runtimeConfig.js";

test("uses the agentic SDLC runtime file beside project repositories", () => {
  // The function returns an absolute path — it is handed to dotenv as a real
  // filesystem location — so the expectation is resolved the same way rather
  // than asserting a relative string the function can never produce.
  const projectDirectory = join("workspace", "orchestrator");
  assert.equal(
    defaultRuntimeSecretsFile(projectDirectory),
    resolve("workspace", ".config", "agentic-sdlc", "runtime.env"),
  );
});
