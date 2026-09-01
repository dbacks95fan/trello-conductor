import type { TrelloCard } from "./trelloClient.js";

export interface WorkContract {
  work_item: string;
  objective: string;
  acceptance_criteria: Record<string, string>;
  required_validation: string[];
  non_goals?: string[];
  constraints?: string[];
}

export class CardParseError extends Error {}

/** Canonical section name -> accepted heading spellings seen on this board so far.
 *  Add aliases here as new phrasing shows up rather than requiring cards to match
 *  one exact convention. */
const SECTION_ALIASES: Record<string, string[]> = {
  "USER STORY": ["USER STORY"],
  "ACCEPTANCE CRITERIA": ["ACCEPTANCE CRITERIA"],
  "PLAYWRIGHT TEST CASES": ["PLAYWRIGHT TEST CASES", "PLAYWRIGHT"],
  "DEFINITION OF DONE": ["DEFINITION OF DONE", "DONE"],
  CONSTRAINTS: ["CONSTRAINTS"],
  "NON-GOALS": ["NON-GOALS", "NON GOALS", "OUT OF SCOPE"],
};

const ALL_KNOWN_HEADINGS = new Set(Object.values(SECTION_ALIASES).flat());

function canonicalHeading(line: string): string | null {
  const upper = line.toUpperCase();
  for (const [canonical, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(upper)) return canonical;
  }
  return null;
}

/** A line that reads as SOME kind of section heading (all-caps, short, no bullet
 *  marker) even if we don't recognize which one — used only to stop a heading we
 *  DO know from silently absorbing content that belongs to a heading we don't. */
function looksLikeUnknownHeading(line: string): boolean {
  if (ALL_KNOWN_HEADINGS.has(line.toUpperCase())) return false; // handled elsewhere
  return (
    line.length > 0 &&
    line.length <= 40 &&
    !line.startsWith("-") &&
    line === line.toUpperCase() &&
    /[A-Z]/.test(line)
  );
}

/** Splits a card description into named sections. Recognizes several heading
 *  spellings per section (SECTION_ALIASES) and — critically — stops accumulating
 *  into a recognized section as soon as ANY heading-shaped line appears, known or
 *  not, so content under a heading we don't map to anything doesn't silently leak
 *  into whichever recognized section happened to come before it. */
function splitSections(desc: string): Record<string, string[]> {
  const lines = desc.split(/\r?\n/);
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const heading = canonicalHeading(line);
    if (heading) {
      current = heading;
      sections[current] ??= [];
      continue;
    }

    if (looksLikeUnknownHeading(line)) {
      current = null; // unrecognized section — stop feeding the previous one
      continue;
    }

    if (!current || !line) continue;

    if (line.startsWith("-")) {
      sections[current].push(line.replace(/^-\s*/, "").trim());
    } else {
      // Non-bullet prose line (e.g. the USER STORY paragraph) — accumulate as text.
      sections[current].push(line);
    }
  }

  return sections;
}

/**
 * Deterministic, non-LLM translation of an already-Planner-authored Trello card
 * into a Work Contract. This is NOT the Codex Planner — it does not originate
 * requirements or use judgment about what "should" be tested; it only reformats
 * structure that a human (or eventually Codex) already wrote. If the expected
 * structure isn't there, it fails loudly rather than guessing.
 */
export function contractFromCard(card: TrelloCard): WorkContract {
  const sections = splitSections(card.desc);

  const userStory = sections["USER STORY"]?.join(" ").trim();
  if (!userStory) {
    throw new CardParseError(
      `Card "${card.name}" has no USER STORY section — cannot derive an objective without guessing.`,
    );
  }

  const acBullets = sections["ACCEPTANCE CRITERIA"] ?? [];
  if (acBullets.length === 0) {
    throw new CardParseError(
      `Card "${card.name}" has no ACCEPTANCE CRITERIA bullets — refusing to invent requirements.`,
    );
  }

  const acceptance_criteria: Record<string, string> = {};
  acBullets.forEach((text, i) => {
    acceptance_criteria[`AC${i + 1}`] = text;
  });

  const required_validation = ["build", "automated_tests"];
  if ((sections["PLAYWRIGHT TEST CASES"] ?? []).length > 0) {
    required_validation.push("playwright");
  }
  const dod = (sections["DEFINITION OF DONE"] ?? []).join(" ");
  if (/docker/i.test(dod)) {
    required_validation.push("docker_build");
  }

  const non_goals = sections["NON-GOALS"] ?? [];
  const constraints = sections["CONSTRAINTS"] ?? [];

  return {
    work_item: `TRELLO-${card.idShort}`,
    objective: userStory,
    acceptance_criteria,
    required_validation,
    ...(non_goals.length ? { non_goals } : {}),
    ...(constraints.length ? { constraints } : {}),
  };
}
