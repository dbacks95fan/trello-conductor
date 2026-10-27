import { config } from "../config.js";
import { getCardsInList, getWorkflowListId } from "../trello/client.js";

/** WIP limits prevent AI from overwhelming human decision capacity during Coding. */
export async function isUnderWipLimit(excludedCardId?: string): Promise<boolean> {
  const workingListId = getWorkflowListId("execution");
  const cards = await getCardsInList(workingListId);
  const otherCards = excludedCardId ? cards.filter((card) => card.id !== excludedCardId) : cards;
  return otherCards.length < config.wipLimit;
}
