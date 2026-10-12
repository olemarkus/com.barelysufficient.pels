/**
 * What the task-creating deadline cards share: the write-refusal translation,
 * the main-home device filter, and the argument validators. Split out of
 * `deadlineObjectiveCards.ts` so the card registrations stay under the file cap
 * as the set of kinds grows.
 */
import { resolveDeferredObjectiveDeadline } from '../lib/objectives/deferredObjectives';
import type { DeferredObjectiveSettingsEntry, ObjectiveWriteOutcome } from '../lib/objectives/deferredObjectives';
import type { DecoratedDeviceSnapshot, TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import { resolveObjectiveWriteRefusalMessage } from '../packages/shared-domain/src/objectiveWriteStrings';
import type { FlowCardDeps } from './registerFlowCards';

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A device-scoped write can refuse to persist on a transient un-confirmable
// migration / untrustworthy settings read / provisional ownership fence. The Flow-card run listeners are
// async, so throwing here lets Homey surface a retryable failure to the user
// instead of the card reporting a (false) success while nothing was written.
// Durable scope refusals (`device_in_sub_home` / `device_not_planned`) throw
// their own honest lines instead of the misleading "try again" framing.
export const throwIfWriteRefused = (outcome: ObjectiveWriteOutcome): void => {
  if (outcome.persisted) return;
  throw new Error(resolveObjectiveWriteRefusalMessage(outcome.reason));
};

// Autocomplete filter for the set-deadline (task-creating) cards: offer
// main-home devices only (multi-home v1 — smart tasks plan against the main
// home's meter budget), mirroring the write gate so the picker never offers a
// device whose card run would then reject with the scope error. The clear and
// trigger cards stay unfiltered: an existing task on a relocated device must
// remain clearable and observable.
export const isOfferedDevice = (deps: FlowCardDeps) => (device: TargetDeviceSnapshot): boolean => (
  deps.hasMainHomeSmartTaskAuthority(device.id)
);

export const validateReadyBy = (raw: unknown): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!LOCAL_TIME_PATTERN.test(value)) {
    throw new Error('Ready by must be HH:mm in 24-hour local time (e.g. "07:00").');
  }
  return value;
};

export const validateNumberInRange = (
  raw: unknown,
  fieldLabel: string,
  min: number,
  max: number,
): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldLabel} must be a number.`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldLabel} must be between ${min} and ${max}.`);
  }
  return value;
};

export const resolveReadyByToDeadlineAtMs = (deps: FlowCardDeps, deadlineLocalTime: string): number => {
  const nowMs = deps.getNow().getTime();
  const resolution = resolveDeferredObjectiveDeadline(nowMs, deps.getTimeZone(), deadlineLocalTime);
  if (resolution.deadlineAtMs === null || resolution.deadlineAtMs <= nowMs) {
    throw new Error(`Could not resolve "${deadlineLocalTime}" to a future moment in time.`);
  }
  return resolution.deadlineAtMs;
};

/**
 * A task-creating deadline card: resolve the device, check it can carry this
 * kind of task, read the card's own target and the ready-by time, and write the
 * task. `readTarget` validates the target before the ready-by time is read, and
 * returns the entry for the resolved deadline.
 *
 * The device-scoped op writes this device's own settings key and runs the
 * shared notify/flush chokepoint. It preserves any standing rescue permission
 * across the update by default (the rescue card promises it sticks until
 * changed or cleared). A per-key write touches only this device, so it cannot
 * clobber a sibling task.
 */
export const registerSetDeadlineCard = <Target extends object>(
  deps: FlowCardDeps,
  cardId: string,
  missingDeviceMessage: string,
  supports: (device: DecoratedDeviceSnapshot) => boolean,
  unsupportedMessage: (deviceLabel: string) => string,
  readTarget: (
    args: Target | null,
    device: DecoratedDeviceSnapshot,
  ) => (deadlineAtMs: number) => DeferredObjectiveSettingsEntry,
): void => {
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    const payload = args as (Target & { device?: RawFlowDeviceArg; ready_by?: unknown }) | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error(missingDeviceMessage);
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!device) throw new Error(`Device '${deviceId}' was not found.`);
    if (!supports(device)) throw new Error(unsupportedMessage(device.name.trim() || deviceId));
    const buildEntry = readTarget(payload, device);
    const deadlineAtMs = resolveReadyByToDeadlineAtMs(deps, validateReadyBy(payload?.ready_by));
    throwIfWriteRefused(deps.upsertDeferredObjectiveForDevice({
      deviceId, deviceName: device.name ?? null, entry: buildEntry(deadlineAtMs),
    }));
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot.filter(supports).filter(isOfferedDevice(deps)), query);
  });
};
