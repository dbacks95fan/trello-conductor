import { config } from "../config.js";

const BASE = "https://api.trello.com/1";

function authQuery(): string {
  return `key=${encodeURIComponent(config.trelloApiKey)}&token=${encodeURIComponent(config.trelloToken)}`;
}

async function trelloFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}${authQuery()}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trello API ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface TrelloList {
  id: string;
  name: string;
  pos: number;
}

export interface TrelloCard {
  id: string;
  idBoard?: string;
  idShort: number;
  name: string;
  desc: string;
  idList: string;
  shortLink: string;
  url: string;
}

export interface TrelloComment {
  id: string;
  data: { text?: string };
}

let listCache: TrelloList[] | null = null;

/** Lists are looked up by name at call time (cached briefly) rather than hardcoded IDs,
 *  so renaming/recreating lists in Trello doesn't require redeploying Trello Conductor. */
export async function getLists(forceRefresh = false): Promise<TrelloList[]> {
  if (listCache && !forceRefresh) return listCache;
  listCache = await trelloFetch<TrelloList[]>(`/boards/${config.boardId}/lists`);
  return listCache;
}

export async function getListIdByName(name: string): Promise<string> {
  let lists = await getLists();
  let matches = lists.filter((l) => l.name === name);
  if (matches.length === 0) {
    lists = await getLists(true); // list may have been created after we cached
    matches = lists.filter((l) => l.name === name);
  }
  if (matches.length === 0) {
    throw new Error(`No list named "${name}" found on board ${config.boardId}`);
  }
  if (matches.length > 1) throw new Error(`Board ${config.boardId} contains more than one list named "${name}".`);
  return matches[0].id;
}

export interface WorkflowListIds {
  newIdeas: string;
  backlog: string;
  prioritized: string;
  specDesign: string;
  execution: string;
  evaluation: string;
  humanApproval: string;
  release: string;
  productionObservation: string;
  done: string;
}

/** Resolve every canonical workflow list by its configured exact name and reject ambiguity. */
export async function getWorkflowListIds(): Promise<WorkflowListIds> {
  const names = [
    config.listNewIdeas,
    config.listBacklog,
    config.listPrioritized,
    config.listSpecDesign,
    config.listWorking,
    config.listReview,
    config.listHumanApproval,
    config.listRelease,
    config.listProductionObservation,
    config.listDone,
  ];
  const lists = await getLists(true);
  const ids = names.map((name) => {
    const matches = lists.filter((list) => list.name === name);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one board list named "${name}"; found ${matches.length}.`);
    }
    return matches[0].id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Canonical workflow list names must resolve to distinct Trello list IDs.");
  return {
    newIdeas: ids[0],
    backlog: ids[1],
    prioritized: ids[2],
    specDesign: ids[3],
    execution: ids[4],
    evaluation: ids[5],
    humanApproval: ids[6],
    release: ids[7],
    productionObservation: ids[8],
    done: ids[9],
  };
}

/** Creates a named board list and invalidates the list cache for subsequent validation. */
export async function createList(name: string, pos: "top" | "bottom" | number = "bottom"): Promise<TrelloList> {
  const query = new URLSearchParams({ name, idBoard: await resolveBoardId(), pos: String(pos) });
  const list = await trelloFetch<TrelloList>(`/lists?${query.toString()}`, { method: "POST" });
  listCache = null;
  return list;
}

/** Repositions a board list without altering the cards it contains. */
export async function updateListPosition(listId: string, pos: number): Promise<TrelloList> {
  const query = new URLSearchParams({ pos: String(pos) });
  const list = await trelloFetch<TrelloList>(`/lists/${listId}?${query.toString()}`, { method: "PUT" });
  listCache = null;
  return list;
}

let realBoardIdCache: string | null = null;

/** Webhook creation requires the board's actual 24-char id — a shortLink (fine
 *  for most GET endpoints) is not reliably accepted there. Resolved once and cached. */
export async function resolveBoardId(): Promise<string> {
  if (realBoardIdCache) return realBoardIdCache;
  const board = await trelloFetch<{ id: string }>(`/boards/${config.boardId}?fields=id`);
  realBoardIdCache = board.id;
  return board.id;
}

export async function getCard(cardId: string): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(`/cards/${cardId}`);
}

export async function getCardComments(cardId: string): Promise<TrelloComment[]> {
  return trelloFetch<TrelloComment[]>(`/cards/${cardId}/actions?filter=commentCard&limit=1000`);
}

export async function getCardsInList(listId: string): Promise<TrelloCard[]> {
  return trelloFetch<TrelloCard[]>(`/lists/${listId}/cards`);
}

export async function moveCard(cardId: string, listId: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idList: listId }),
  });
}

export async function updateCardDescription(cardId: string, desc: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ desc }),
  });
}

export async function commentOnCard(cardId: string, text: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}/actions/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export interface TrelloWebhook {
  id: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
}

export async function listWebhooks(): Promise<TrelloWebhook[]> {
  return trelloFetch<TrelloWebhook[]>(`/tokens/${config.trelloToken}/webhooks`);
}

export async function createWebhook(callbackURL: string, idModel: string): Promise<TrelloWebhook> {
  return trelloFetch<TrelloWebhook>(`/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Trello Conductor: Agentic SDLC lifecycle transition handler",
      callbackURL,
      idModel,
    }),
  });
}

/** Idempotent: reuses an existing webhook for this board+callback URL if one exists. */
export async function ensureWebhook(callbackURL: string, idModel: string): Promise<TrelloWebhook> {
  const existing = await listWebhooks();
  const match = existing.find((w) => w.idModel === idModel && w.callbackURL === callbackURL);
  if (match) return match;
  return createWebhook(callbackURL, idModel);
}
