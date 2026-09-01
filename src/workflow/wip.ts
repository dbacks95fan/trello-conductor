import { config } from "../config.js";
import { getCardsInList, getListIdByName } from "../trello/client.js";

/** WIP limits to prevent AI from overwhelming human decision capacity — the
 *  orchestrator refuses to start new work if the "Agent Working" list is already
 *  at (or over) the configured limit. */
export async function isUnderWipLimit(): Promise<boolean> {
  const workingListId = await getListIdByName(config.listWorking);
  const cards = await getCardsInList(workingListId);
  return cards.length < config.wipLimit;
}
