// ABOUTME: Provides a deliberate dry-run and apply command for creating compliant Trello boards.
import { bootstrapBoard } from "./boardBootstrap.js";
import { loadBoardWorkflowTemplate } from "./boardTemplate.js";
import { config } from "./config.js";
import { createList, getLists, updateListPosition } from "./trello/client.js";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (apply === dryRun) {
  throw new Error("Use exactly one mode: --dry-run or --apply.");
}

const template = await loadBoardWorkflowTemplate(config.boardWorkflowTemplate);
const result = await bootstrapBoard({ getLists, createList, updateListPosition }, template.listNames, apply);
console.log(JSON.stringify({ board: config.boardId, templateVersion: template.templateVersion, ...result }, null, 2));
