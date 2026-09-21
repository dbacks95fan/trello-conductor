import { config } from "../config.js";
import { getCardsInList, getListIdByName } from "../trello/client.js";

/** WIP limits prevent AI from overwhelming human decision capacity during Coding. */
export async function isUnderWipLimit(): Promise<boolean> {
  const workingListId = await getListIdByName(config.listWorking);
  const cards = await getCardsInList(workingListId);
  return cards.length < config.wipLimit;
}
