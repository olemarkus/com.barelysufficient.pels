/*
 * Pure normalizer for the Homey user-flow lists.
 *
 * PELS reads the owner's configured Homey Flows to detect when a user flow
 * already writes a device capability that PELS would otherwise own under
 * native wiring (the "flow conflict" signal — see notes/native-wiring/).
 *
 * This module is intentionally pure: it takes already-fetched flow-list
 * responses (shape `unknown`, straight off the Web API) and extracts the
 * raw signals — which device capabilities are written by a Flow action and
 * which chargers receive PELS battery reports. It does NOT know PELS'
 * per-device-class native-write sets or the owner's selected-car settings;
 * those facts are combined by their respective consumers.
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
 * PELS-app bridge cards do not count as device-capability writes: a bridge
 * flow's native-control conflict surfaces through the vendor capability its
 * action writes. The one separately owned fact is PELS' battery-report action,
 * which is normalized by charger so the UI can detect when selecting a car has
 * made that Flow action redundant.
 */

/**
 * deviceId → capabilityId → (flowId → flowName) for every device-capability
 * written by some user-flow action.
 *
 * The flow id is the identity (two different Flows can share a display name),
 * and the name is carried alongside so a later UI surface can name the single
 * Flow responsible for a conflict. The name may be `''` when the Flow has no
 * usable name; the conflict classifier treats that as "cannot name".
 */
export type FlowCapabilityWrites = Map<string, Map<string, Map<string, string>>>;

/**
 * Flow-inventory fact owned and normalized by `lib/flowApi`: one entry per
 * charger targeted by an enabled battery-report action. `flowName` is present
 * only when exactly one named Flow reports for that charger.
 * Governing contract: `notes/native-wiring/README.md`.
 */
export type EvSocFlowReporter = {
  chargerDeviceId: string;
  flowName?: string;
};

/** Clean result of normalizing both Homey Flow inventories. */
export type UserFlowFacts = {
  writes: FlowCapabilityWrites;
  evSocReporters: EvSocFlowReporter[];
};

const DEVICE_CARD_ID_PREFIX = 'homey:device:';
export const EV_SOC_REPORT_CARD_ID = 'homey:app:com.barelysufficient.pels:report_evcharger_battery_level';

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

function readFlowDeviceId(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string') return value.id.trim() || null;
  return isRecord(value.data) && typeof value.data.id === 'string'
    ? value.data.id.trim() || null
    : null;
}

/**
 * `undefined` means this is not the PELS battery-report action; `null` means
 * it is that action but its charger argument is malformed.
 */
export function parseEvSocReportTarget(card: unknown): string | null | undefined {
  if (!isRecord(card) || card.id !== EV_SOC_REPORT_CARD_ID) return undefined;
  if (!isRecord(card.args)) return null;
  return readFlowDeviceId(card.args.device);
}

function recordWrite(
  writes: FlowCapabilityWrites,
  deviceId: string,
  capabilityId: string,
  flowId: string,
  flowName: string,
): void {
  let byCapability = writes.get(deviceId);
  if (!byCapability) {
    byCapability = new Map();
    writes.set(deviceId, byCapability);
  }
  let byFlow = byCapability.get(capabilityId);
  if (!byFlow) {
    byFlow = new Map();
    byCapability.set(capabilityId, byFlow);
  }
  byFlow.set(flowId, flowName);
}

function collectFromCard(
  writes: FlowCapabilityWrites,
  evSocReports: Map<string, Map<string, string>>,
  card: unknown,
  flowId: string,
  flowName: string,
): void {
  if (!isRecord(card)) return;
  const write = parseDeviceCapabilityWrite(card.id);
  if (write) recordWrite(writes, write.deviceId, write.capabilityId, flowId, flowName);
  const chargerDeviceId = parseEvSocReportTarget(card);
  if (typeof chargerDeviceId === 'string') {
    let byFlow = evSocReports.get(chargerDeviceId);
    if (!byFlow) {
      byFlow = new Map();
      evSocReports.set(chargerDeviceId, byFlow);
    }
    byFlow.set(flowId, flowName);
  }
}

// A Flow's display name, or '' when it has no usable name (the classifier
// then cannot name it and falls back to the generic conflict copy).
function flowDisplayName(flow: Record<string, unknown>): string {
  return typeof flow.name === 'string' ? flow.name.trim() : '';
}

// A flow with `enabled === false` is returned by the Web API with its cards
// intact, but Homey never executes its actions — so it cannot conflict with
// native wiring. Skip it. A missing/true `enabled` is treated as active (the
// conflict-safe direction: when unsure, assume the flow can write).
function isDisabledFlow(flow: Record<string, unknown>): boolean {
  return flow.enabled === false;
}

function collectFromFlatFlows(
  writes: FlowCapabilityWrites,
  evSocReports: Map<string, Map<string, string>>,
  flatFlows: Record<string, unknown>,
): void {
  for (const [flowId, flow] of Object.entries(flatFlows)) {
    if (!isRecord(flow) || isDisabledFlow(flow)) continue;
    const actions = flow.actions;
    if (!Array.isArray(actions)) continue;
    const flowName = flowDisplayName(flow);
    for (const action of actions) {
      collectFromCard(writes, evSocReports, action, flowId, flowName);
    }
  }
}

function collectFromAdvancedFlows(
  writes: FlowCapabilityWrites,
  evSocReports: Map<string, Map<string, string>>,
  advancedFlows: Record<string, unknown>,
): void {
  for (const [flowId, flow] of Object.entries(advancedFlows)) {
    if (!isRecord(flow) || isDisabledFlow(flow)) continue;
    const cards = flow.cards;
    if (!isRecord(cards)) continue;
    const flowName = flowDisplayName(flow);
    for (const card of Object.values(cards)) {
      if (!isRecord(card) || card.type !== 'action') continue;
      collectFromCard(writes, evSocReports, card, flowId, flowName);
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
  return normalizeUserFlowFacts(flatFlows, advancedFlows).writes;
}

export function normalizeUserFlowFacts(
  flatFlows: Record<string, unknown>,
  advancedFlows: Record<string, unknown>,
): UserFlowFacts {
  const writes: FlowCapabilityWrites = new Map();
  const evSocReports = new Map<string, Map<string, string>>();
  collectFromFlatFlows(writes, evSocReports, flatFlows);
  collectFromAdvancedFlows(writes, evSocReports, advancedFlows);
  const evSocReporters = [...evSocReports.entries()].map(([chargerDeviceId, byFlow]) => {
    const names = [...byFlow.values()];
    const flowName = byFlow.size === 1 && names[0] ? names[0] : undefined;
    return flowName === undefined ? { chargerDeviceId } : { chargerDeviceId, flowName };
  });
  return { writes, evSocReporters };
}
