// ABOUTME: Resolves a Spec & Design work request from a Trello card and the frozen intent in intent-backlog.
import type { TrelloCard } from "../trello/client.js";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

/** Raised when a card in Spec & Design does not carry a usable, frozen intent
 *  reference. The workflow turns this into a card comment and leaves the card
 *  in place rather than starting the agent from a guess. */
export class SpecRequestError extends Error {}

/** The identifier shape the Spec & Design Agent's request schema requires for
 *  `workItem` (e.g. INT-MF-0042). */
const INTENT_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^(?:sha256:)?([0-9a-f]{64})$/;

/** The Intent Creation Skill projects these lines into the card description
 *  (intent-creation-skill/references/work-tracking.md, "Trello card contract").
 *  Labels are matched case-insensitively and tolerate surrounding `**` bold. */
interface CardIntentMetadata {
  productId: string;
  intentId: string;
  intentVersion: number;
  intentCommit: string;
  intentContentSha256: string;
  intentStatus: string;
  canonicalIntentUrl: string;
}

export interface ResolvedSpecRequest {
  intentId: string;
  productId: string;
  intentVersion: number;
  intentCommit: string;
  intentContentSha256: string;
  intentRepository: string;
  intentPath: string;
  frozenIntentBytes: Buffer;
  approvedBy: string;
  approvedAt: string;
  warnings: string[];
}

export interface ResolveSpecRequestOptions {
  githubApiBase: string;
  githubToken: string;
  approvedBy: string;
  approvedAt: string;
  fetchFn?: typeof fetch;
}

/** Reads a `Label: value` line from the card description, tolerating a leading
 *  list marker and Markdown bold around the label and/or the colon
 *  (`- **Intent ID:** X`, `**Intent ID**: X`, `Intent ID: X`). The value itself
 *  may contain colons (URLs), so only the first colon is treated as separator. */
function metadataValue(desc: string, label: string): string | undefined {
  const wanted = label.toLowerCase();
  for (const raw of desc.split(/\r?\n/)) {
    const cleaned = raw.replace(/\*\*/g, "").replace(/^\s*[-*+]\s+/, "").trim();
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    if (cleaned.slice(0, colon).trim().toLowerCase() !== wanted) continue;
    const value = cleaned.slice(colon + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function parseCardIntentMetadata(card: TrelloCard): CardIntentMetadata {
  const desc = card.desc ?? "";
  const productLine = metadataValue(desc, "Product");
  const productId = productLine?.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  const intentId = metadataValue(desc, "Intent ID");
  const versionRaw = metadataValue(desc, "Intent Version");
  const intentCommit = metadataValue(desc, "Intent Commit")?.toLowerCase();
  const hashRaw = metadataValue(desc, "Intent Hash");
  const intentStatus = metadataValue(desc, "Intent Status");
  const canonicalIntentUrl = metadataValue(desc, "Canonical intent");

  const missing = Object.entries({
    "Product (with a parenthesised product ID)": productId,
    "Intent ID": intentId,
    "Intent Version": versionRaw,
    "Intent Commit": intentCommit,
    "Intent Hash": hashRaw,
    "Intent Status": intentStatus,
    "Canonical intent": canonicalIntentUrl,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new SpecRequestError(
      `Card "${card.name}" is missing intent metadata the Intent Creation Skill is expected to project onto the card: ${missing.join(", ")}.`,
    );
  }

  if (!INTENT_ID.test(intentId!)) {
    throw new SpecRequestError(`Intent ID "${intentId}" is not a product-prefixed identifier such as INT-MF-0042.`);
  }
  const intentVersion = Number(versionRaw);
  if (!Number.isInteger(intentVersion) || intentVersion < 1) {
    throw new SpecRequestError(`Intent Version "${versionRaw}" is not a positive integer.`);
  }
  if (!FULL_SHA.test(intentCommit!)) {
    throw new SpecRequestError(`Intent Commit "${intentCommit}" is not a full 40-character Git SHA.`);
  }
  const contentHash = hashRaw!.match(CONTENT_HASH)?.[1];
  if (!contentHash) {
    throw new SpecRequestError(`Intent Hash "${hashRaw}" is not a sha256 content hash.`);
  }
  if (intentStatus!.toLowerCase() !== "frozen") {
    throw new SpecRequestError(
      `Intent Status is "${intentStatus}", not "Frozen". A card should only enter Spec & Design after its intent is frozen at Ready for Planning.`,
    );
  }

  return {
    productId: productId!,
    intentId: intentId!,
    intentVersion,
    intentCommit: intentCommit!,
    intentContentSha256: contentHash,
    intentStatus: intentStatus!,
    canonicalIntentUrl: canonicalIntentUrl!,
  };
}

interface CanonicalLocation {
  owner: string;
  repo: string;
  path: string;
}

export function parseCanonicalIntentUrl(url: string): CanonicalLocation {
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+?)(?:[?#].*)?$/,
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+?)(?:[?#].*)?$/,
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+?)(?:[?&].*)?$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { owner: match[1], repo: match[2], path: decodeURIComponent(match[3]) };
  }
  throw new SpecRequestError(`Canonical intent URL is not a recognised GitHub file URL: ${url}`);
}

async function fetchFrozenIntent(
  location: CanonicalLocation,
  ref: string,
  options: ResolveSpecRequestOptions,
): Promise<Buffer> {
  const encodedPath = location.path.split("/").map(encodeURIComponent).join("/");
  const url = `${options.githubApiBase.replace(/\/$/, "")}/repos/${location.owner}/${location.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "trello-conductor",
  };
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;

  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint =
      response.status === 404 || response.status === 401 || response.status === 403
        ? " If intent-backlog is private, set GITHUB_TOKEN in the shared runtime file."
        : ` ${body.slice(0, 200)}`;
    throw new SpecRequestError(
      `GitHub returned HTTP ${response.status} fetching the frozen intent ${location.owner}/${location.repo}@${ref.slice(0, 12)} ${location.path}.${hint}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function frozenIntentFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new SpecRequestError("The frozen intent.md has no YAML frontmatter to verify identity against.");
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object") {
    throw new SpecRequestError("The frozen intent.md frontmatter did not parse as a mapping.");
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Resolves and integrity-checks the frozen intent a Spec & Design run needs.
 *  Strong disagreements between the card projection and the canonical artifact
 *  throw; softer ones (self-referential commit field, card-id spelling) are
 *  returned as warnings for the workflow to surface on the card. */
export async function resolveSpecRequest(
  card: TrelloCard,
  options: ResolveSpecRequestOptions,
): Promise<ResolvedSpecRequest> {
  const meta = parseCardIntentMetadata(card);
  const location = parseCanonicalIntentUrl(meta.canonicalIntentUrl);
  const frozenIntentBytes = await fetchFrozenIntent(location, meta.intentCommit, options);
  const fm = frozenIntentFrontmatter(frozenIntentBytes.toString("utf8"));

  const mismatches: string[] = [];
  if (str(fm.intent_id) !== meta.intentId) mismatches.push(`intent_id (card ${meta.intentId} vs backlog ${str(fm.intent_id) || "missing"})`);
  if (str(fm.product_id) !== meta.productId) mismatches.push(`product_id (card ${meta.productId} vs backlog ${str(fm.product_id) || "missing"})`);
  if (Number(fm.intent_version) !== meta.intentVersion) mismatches.push(`intent_version (card ${meta.intentVersion} vs backlog ${str(fm.intent_version) || "missing"})`);
  if (str(fm.status).toLowerCase() !== "frozen") mismatches.push(`status (backlog status is "${str(fm.status) || "missing"}", not Frozen)`);
  const backlogHash = str(fm.intent_hash).match(CONTENT_HASH)?.[1];
  if (backlogHash !== meta.intentContentSha256) mismatches.push("intent_hash (card projection and backlog artifact disagree)");
  if (mismatches.length > 0) {
    throw new SpecRequestError(
      `The Trello card and the canonical intent.md disagree and must be reconciled before Spec & Design starts: ${mismatches.join("; ")}.`,
    );
  }

  const warnings: string[] = [];
  const backlogCommit = str(fm.intent_commit).toLowerCase();
  if (backlogCommit && backlogCommit !== meta.intentCommit) {
    warnings.push(
      `The frozen intent.md records intent_commit ${backlogCommit.slice(0, 12)} but the card pins ${meta.intentCommit.slice(0, 12)}; using the card's commit. This is expected when the hash-bearing commit cannot contain its own SHA.`,
    );
  }
  const backlogCardId = str(fm.trello_card_id);
  if (backlogCardId && ![card.id, String(card.idShort), card.shortLink].includes(backlogCardId) && !card.url.includes(backlogCardId)) {
    warnings.push(`The frozen intent.md records trello_card_id "${backlogCardId}" which does not obviously match this card (${card.idShort}).`);
  }

  let approvedAt = options.approvedAt;
  const frozenAt = str(fm.frozen_at);
  if (frozenAt && !Number.isNaN(Date.parse(frozenAt))) approvedAt = frozenAt;

  return {
    intentId: meta.intentId,
    productId: meta.productId,
    intentVersion: meta.intentVersion,
    intentCommit: meta.intentCommit,
    intentContentSha256: meta.intentContentSha256,
    intentRepository: `${location.owner}/${location.repo}`,
    intentPath: location.path,
    frozenIntentBytes,
    approvedBy: options.approvedBy,
    approvedAt,
    warnings,
  };
}

/** Convenience used by tests and callers that already hold the frozen bytes. */
export function frozenArtifactSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
