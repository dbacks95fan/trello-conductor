// ABOUTME: Loads the versioned SDLC board template so every product board uses the same lifecycle.
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface BoardWorkflowTemplate {
  templateVersion: number;
  listNames: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects malformed templates before a board mutation can occur. */
export function parseBoardWorkflowTemplate(source: string): BoardWorkflowTemplate {
  const parsed: unknown = parse(source);
  if (!isRecord(parsed) || ![1, 2].includes(parsed.template_version as number) || !Array.isArray(parsed.lists)) {
    throw new Error("Board workflow template must declare a supported template_version (1 or 2) and a lists array.");
  }

  const listNames = parsed.lists;
  if (!listNames.every((name): name is string => typeof name === "string" && name.trim().length > 0)) {
    throw new Error("Board workflow template lists must contain non-empty names.");
  }
  if (new Set(listNames).size !== listNames.length) {
    throw new Error("Board workflow template list names must be unique.");
  }

  return { templateVersion: parsed.template_version as number, listNames: Object.freeze([...listNames]) };
}

/** Reads the repository-owned board template used by the Conductor bootstrap command. */
export async function loadBoardWorkflowTemplate(path: string): Promise<BoardWorkflowTemplate> {
  return parseBoardWorkflowTemplate(await readFile(path, "utf8"));
}
