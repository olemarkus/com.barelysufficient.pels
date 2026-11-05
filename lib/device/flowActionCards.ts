import type { HomeyFlowAction } from './transport/homeyActionAccess';

/**
 * The Flow action cards Homey lists (`manager/flow/flowcardaction`), by card
 * id: the installed metadata a device's app actions are resolved against, so
 * PELS runs only a card that really exists. Entries without a string id are
 * skipped; an unreadable inventory throws so its owner retains the last read.
 */
export type FlowActionCardIds = ReadonlySet<string>;

export const FLOW_ACTION_CARDS_API_PATH = 'manager/flow/flowcardaction';

export function readFlowActionCardIds(inventory: unknown): FlowActionCardIds {
  let entries: unknown[];
  if (Array.isArray(inventory)) entries = inventory;
  else if (typeof inventory === 'object' && inventory !== null) entries = Object.values(inventory);
  else throw new Error('Unreadable Flow action card inventory.');
  return new Set(entries.flatMap((entry) => (
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' ? [entry.id] : []
  )));
}

/**
 * One app action card run on one device, as an integration states it: the
 * card's id within its app (`actionId`), the device it acts on, and its own
 * arguments, without the device argument. Common transport resolves it against
 * the card inventory (`resolveDeviceActionCard`).
 */
export type DeviceActionStep = {
  deviceId: string;
  actionId: string;
  args: Readonly<Record<string, unknown>>;
};

/**
 * The exact card Homey lists for `step`: the device-owned card
 * (`homey:device:<id>:<actionId>`) when there is one, else the app's card
 * (`<appUri>:<actionId>`) with the device as its `device` argument.
 * `undefined` when the inventory lists neither: the app does not offer it.
 */
export function resolveDeviceActionCard(
  cards: FlowActionCardIds,
  appUri: string,
  step: DeviceActionStep,
): HomeyFlowAction | undefined {
  const ownerUri = `homey:device:${step.deviceId}`;
  const cardId = `${ownerUri}:${step.actionId}`;
  if (cards.has(cardId)) return { ownerUri, cardId, args: step.args };
  const appCardId = `${appUri}:${step.actionId}`;
  if (!cards.has(appCardId)) return undefined;
  return { ownerUri: appUri, cardId: appCardId, args: { device: { id: step.deviceId }, ...step.args } };
}
