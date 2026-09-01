import { config } from "./config.js";

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
}

export interface TrelloCard {
  id: string;
  idShort: number;
  name: string;
  desc: string;
  idList: string;
  shortLink: string;
  url: string;
}

let listCache: TrelloList[] | null = null;

/** Lists are looked up by name at call time (cached briefly) rather than hardcoded IDs,
 *  so renaming/recreating lists in Trello doesn't require redeploying the orchestrator. */
export async function getLists(forceRefresh = false): Promise<TrelloList[]> {
  if (listCache && !forceRefresh) return listCache;
  listCache = await trelloFetch<TrelloList[]>(`/boards/${config.boardId}/lists`);
  return listCache;
}

export async function getListIdByName(name: string): Promise<string> {
  let lists = await getLists();
  let found = lists.find((l) => l.name === name);
  if (!found) {
    lists = await getLists(true); // list may have been created after we cached
    found = lists.find((l) => l.name === name);
  }
  if (!found) {
    throw new Error(`No list named "${name}" found on board ${config.boardId}`);
  }
  return found.id;
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
      description: "orchestrator: Ready for Agent watcher",
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
