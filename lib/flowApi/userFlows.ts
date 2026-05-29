/*
 * Pure normalizer for the Homey user-flow lists.
 *
 * PELS reads the owner's configured Homey Flows to detect when a user flow
 * already writes a device capability that PELS would otherwise own under
 * native wiring (the "flow conflict" signal — see notes/native-wiring/).
 *
 * This module is intentionally pure: it takes already-fetched flow-list
 * responses (shape `unknown`, straight off the Web API) and extracts the
 * raw signal — which device capabilities are written by a flow ACTION card.
 * It does NOT know PELS' per-device-class native-write sets; intersecting
 * the write map with those sets is the conflict classifier's job (a later
 * PR). Keeping that boundary here is what makes this PR zero-behaviour.
 *
 * Two endpoints, two shapes, one extraction rule:
 *   - /api/manager/flow/flow/         → { [flowId]: { trigger, conditions, actions } }
 *       each action is { uri, id, args }
 *   - /api/manager/flow/advancedflow/ → { [flowId]: { cards: { [cardId]: { ownerUri, id, args, type } } } }
 *       a capability action card has type === 'action'
 *
 * In both shapes a direct device-capability action carries
 *   id === `homey:device:<deviceId>:<capabilityId>`
 * (capability ids may contain dots, e.g. `alarm_generic.car_connected`, but
 * never colons — so deviceId is the segment up to the first colon after the
 * `homey:device:` prefix, and capabilityId is the remainder).
 *
 * PELS-app bridge cards (e.g. `homey:app:com.barelysufficient.pels:desired_stepped_load_changed`)
 * do not match the `homey:device:` prefix and are intentionally ignored: a
 * bridge flow's conflict surfaces through the vendor capability its action
 * writes, which is captured here as a normal device-capability write.
 */

/** deviceId → set of capability ids written by some user-flow action. */
export type FlowCapabilityWrites = Map<string, Set<string>>;

const DEVICE_CARD_ID_PREFIX = 'homey:device:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a flow card's `id` into a device-capability write, or null when the
 * card does not write a device capability (PELS-app card, manager card,
 * malformed id, missing capability segment).
 */
export function parseDeviceCapabilityWrite(
  cardId: unknown,
): { deviceId: string; capabilityId: string } | null {
  if (typeof cardId !== 'string' || !cardId.startsWith(DEVICE_CARD_ID_PREFIX)) return null;
  const rest = cardId.slice(DEVICE_CARD_ID_PREFIX.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex <= 0) return null;
  const deviceId = rest.slice(0, separatorIndex);
  const capabilityId = rest.slice(separatorIndex + 1);
  if (!deviceId || !capabilityId) return null;
  return { deviceId, capabilityId };
}

function recordWrite(writes: FlowCapabilityWrites, deviceId: string, capabilityId: string): void {
  const existing = writes.get(deviceId);
  if (existing) {
    existing.add(capabilityId);
    return;
  }
  writes.set(deviceId, new Set([capabilityId]));
}

function collectFromCard(writes: FlowCapabilityWrites, card: unknown): void {
  if (!isRecord(card)) return;
  const write = parseDeviceCapabilityWrite(card.id);
  if (write) recordWrite(writes, write.deviceId, write.capabilityId);
}

// A flow with `enabled === false` is returned by the Web API with its cards
// intact, but Homey never executes its actions — so it cannot conflict with
// native wiring. Skip it. A missing/true `enabled` is treated as active (the
// conflict-safe direction: when unsure, assume the flow can write).
function isDisabledFlow(flow: Record<string, unknown>): boolean {
  return flow.enabled === false;
}

function collectFromFlatFlows(writes: FlowCapabilityWrites, flatFlows: Record<string, unknown>): void {
  for (const flow of Object.values(flatFlows)) {
    if (!isRecord(flow) || isDisabledFlow(flow)) continue;
    const actions = flow.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      collectFromCard(writes, action);
    }
  }
}

function collectFromAdvancedFlows(
  writes: FlowCapabilityWrites,
  advancedFlows: Record<string, unknown>,
): void {
  for (const flow of Object.values(advancedFlows)) {
    if (!isRecord(flow) || isDisabledFlow(flow)) continue;
    const cards = flow.cards;
    if (!isRecord(cards)) continue;
    for (const card of Object.values(cards)) {
      if (!isRecord(card) || card.type !== 'action') continue;
      collectFromCard(writes, card);
    }
  }
}

/**
 * Merge both endpoint responses into one device-capability write map.
 * Defensive against unexpected shapes: anything that is not a flow map / not
 * an action card / not a device-capability id is skipped rather than thrown.
 * An empty or fully-unrecognised input yields an empty map (the caller, not
 * this function, distinguishes "read failed" from "read OK, nothing found").
 */
export function normalizeFlowCapabilityWrites(
  flatFlows: Record<string, unknown>,
  advancedFlows: Record<string, unknown>,
): FlowCapabilityWrites {
  const writes: FlowCapabilityWrites = new Map();
  collectFromFlatFlows(writes, flatFlows);
  collectFromAdvancedFlows(writes, advancedFlows);
  return writes;
}
