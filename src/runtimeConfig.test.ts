// ABOUTME: Verifies the stable workspace location used for non-repository runtime secrets.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { defaultRuntimeSecretsFile } from "./runtimeConfig.js";

test("uses the agentic SDLC runtime file beside project repositories", () => {
  const projectDirectory = join("workspace", "orchestrator");
  assert.equal(defaultRuntimeSecretsFile(projectDirectory), join("workspace", ".config", "agentic-sdlc", "runtime.env"));
});
