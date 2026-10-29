// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Starts a previously recorded Spec & Design transition from a local operator CLI.
import { runManualSpecDesign } from "./workflow/workflow.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf("--card-id");
  const cardId = index >= 0 ? args[index + 1] : undefined;
  if (!cardId || cardId.startsWith("--")) {
    console.error("Usage: npm run spec-design:manual -- --card-id <trello-card-id>");
    process.exitCode = 2;
    return;
  }

  try {
    await runManualSpecDesign(cardId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
