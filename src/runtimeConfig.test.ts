// ABOUTME: Verifies the stable user-level location used for non-repository runtime secrets.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { defaultRuntimeSecretsFile } from "./runtimeConfig.js";

test("uses the agentic SDLC runtime file beneath the user home directory", () => {
  assert.equal(defaultRuntimeSecretsFile("C:/Users/Sobe"), join("C:/Users/Sobe", ".config", "agentic-sdlc", "runtime.env"));
});
