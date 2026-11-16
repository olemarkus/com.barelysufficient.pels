import type { DeviceOverride } from '../../../../shared-domain/src/settings/deviceOverrides.ts';
import {
  getPrimaryTargetCapability, normalizeTargetCapabilityValue,
} from '../../../../shared-domain/src/targetCapabilities.ts';
import { resolveTemperatureControlMode } from '../../../../shared-domain/src/settings/temperatureControl.ts';
import {
  CLOCK_ALLOWANCE_MS, OVERRIDE_COPY, changeOverrideDraft, formatActiveOverride, formatOverrideEndLine, newOverrideDraft,
  resolveOverrideDraft, resolveOverrideSmartTaskNote,
  type OverrideDraft,
  type OverrideTemperatureRange,
} from '../deviceOverrideDraft.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import {
  DEVICE_OVERRIDE_CHANGED_EVENT, getActiveDeviceOverride, hasLoadedDeviceOverride, loadDeviceOverride,
  saveDeviceOverride,
} from '../deviceOverrideStore.ts';
import { getHomeyTimezone } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { hasOpenSmartTask, resolveManagedState, state } from '../state.ts';
import { getTargetCapabilityStep } from '../targetCapabilityStep.ts';
import { showToast, showToastError } from '../toast.ts';
import type {
  DeviceOverrideCardActions, DeviceOverrideCardState, OverrideScheduleLink,
} from '../views/DeviceOverrideCard.tsx';

/**
 * The Override row of the device page's Temporary card (`temporaryCard.ts`), on
 * a managed thermostat's page: start a temperature override, see the one in
 * force, change it, end it early. This module holds the row's state and its
 * form; the card paints it.
 *
 * The device's stored override lives in `deviceOverrideStore.ts`, which reads
 * and writes its `device_override.<deviceId>` key through the settings bridge;
 * the runtime owner (`lib/overrides/deviceOverrides.ts`) decides what the plan
 * does with it. Ending early stores an end time of now.
 */
type CardSession = {
  deviceId: string;
  draft: OverrideDraft | null;
  /** The draft changes an override in force; `false` for a new one. */
  changing: boolean;
  error: string | null;
  busy: boolean;
};

let session: CardSession | null = null;
// What the card last resolved to, for the Temporary card to paint; `null` when the row does not apply.
let shown: DeviceOverrideCardState | null = null;
let notify: () => void = () => {};

/** The Override row's state for the open device, or `null` when it has none. */
export const getDeviceOverrideCardState = (): DeviceOverrideCardState | null => shown;

/** Called whenever the row's state changes. */
export const onDeviceOverrideCardChange = (listener: () => void): void => { notify = listener; };

const findDevice = (deviceId: string): SettingsUiDeviceDetailItem | undefined => (
  state.latestDevices.find((device) => device.id === deviceId)
);

const finiteOrNull = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const temperatureRange = (device: SettingsUiDeviceDetailItem): OverrideTemperatureRange & { step: number } | null => {
  const target = getPrimaryTargetCapability(device.targets);
  if (!target) return null;
  return { min: finiteOrNull(target.min), max: finiteOrNull(target.max), step: getTargetCapabilityStep(target) };
};

const activeOverride = (current: CardSession, nowMs: number): DeviceOverride | null => (
  getActiveDeviceOverride(current.deviceId, nowMs)
);

/** What the draft means for the device's open Smart task, when it has one. */
const smartTaskNote = (current: CardSession, draft: OverrideDraft, range: OverrideTemperatureRange): string | null => {
  const task = state.deferredObjectiveSettings.objectivesByDeviceId[current.deviceId];
  if (!task || !hasOpenSmartTask(current.deviceId)) return null;
  const resolved = resolveOverrideDraft(draft, range, Date.now(), getHomeyTimezone());
  return resolveOverrideSmartTaskNote(resolved.ok ? resolved.untilMs : null, task.deadlineAtMs);
};

const resolveCardState = (current: CardSession, device: SettingsUiDeviceDetailItem): DeviceOverrideCardState | null => {
  const range = temperatureRange(device);
  if (range === null) return null;
  const mode = resolveTemperatureControlMode(
    state.temperatureControlModes, state.temperatureControlDisabledMap, device.id,
  );
  if (mode === 'external') return { kind: 'blocked' };
  if (current.draft !== null) {
    const resolved = resolveOverrideDraft(current.draft, range, Date.now(), getHomeyTimezone());
    return {
      kind: 'editing', draft: current.draft, range, error: current.error, busy: current.busy,
      smartTaskNote: smartTaskNote(current, current.draft, range),
      endLine: resolved.ok ? formatOverrideEndLine(resolved.untilMs, Date.now(), getHomeyTimezone()) : null,
      changing: current.changing,
    };
  }
  const nowMs = Date.now();
  const active = activeOverride(current, nowMs);
  if (active === null) return { kind: 'idle' };
  return { kind: 'active', busy: current.busy, line: formatActiveOverride(active, nowMs, getHomeyTimezone()) };
};

/**
 * What a new schedule for the open device starts as: an override at the
 * temperature in force, or the device's usual one. `null` for a device with no
 * Override row.
 */
export const getDeviceOverrideScheduleLink = (): OverrideScheduleLink | null => {
  if (!session || shown === null || shown.kind === 'blocked') return null;
  const device = findDevice(session.deviceId);
  if (!device) return null;
  const active = activeOverride(session, Date.now());
  return { deviceId: device.id, temperatureC: active?.setting.targetC ?? usualTemperature(device) };
};

const paint = (): void => {
  if (!session) return;
  const device = findDevice(session.deviceId);
  const applies = device !== undefined && hasLoadedDeviceOverride(session.deviceId)
    && supportsTemperatureDevice(device) && resolveManagedState(device.id);
  shown = applies ? resolveCardState(session, device) : null;
  notify();
};

/**
 * Where a new override starts from: the device's target in the active mode,
 * which is what it returns to. The device's own setpoint may be a price shift
 * or a limit away from that; it stands in only when the mode has no target.
 */
const usualTemperature = (device: SettingsUiDeviceDetailItem): number | null => {
  const modeTarget = state.modeTargets[state.activeMode]?.[device.id];
  if (typeof modeTarget === 'number' && Number.isFinite(modeTarget)) return modeTarget;
  const setpoint = getPrimaryTargetCapability(device.targets)?.value;
  return typeof setpoint === 'number' && Number.isFinite(setpoint) ? setpoint : null;
};

const onStart = (): void => {
  if (!session) return;
  const device = findDevice(session.deviceId);
  if (!device) return;
  const nowMs = Date.now();
  const active = activeOverride(session, nowMs);
  const timeZone = getHomeyTimezone();
  const draft = active
    ? changeOverrideDraft(active, timeZone) : newOverrideDraft(usualTemperature(device), nowMs, timeZone);
  session = { ...session, draft, changing: active !== null, error: null };
  paint();
};

const onDraftChange = (patch: Partial<OverrideDraft>): void => {
  if (!session?.draft) return;
  session = { ...session, draft: { ...session.draft, ...patch }, error: null };
  paint();
};

const onCancel = (): void => {
  if (!session) return;
  session = { ...session, draft: null, error: null };
  paint();
};

const write = async (current: CardSession, override: DeviceOverride, done: string): Promise<void> => {
  session = { ...current, busy: true, error: null };
  paint();
  try {
    await saveDeviceOverride(current.deviceId, override);
    if (session?.deviceId !== current.deviceId) return;
    session = { ...session, draft: null, busy: false };
    void showToast(done, 'ok');
  } catch (error) {
    void logSettingsError('Failed to save device override', error, 'device override');
    void showToastError(error, OVERRIDE_COPY.saveFailed);
    if (session?.deviceId === current.deviceId) session = { ...session, busy: false };
  }
  paint();
};

const onSave = (): void => {
  if (!session?.draft || session.busy) return;
  const device = findDevice(session.deviceId);
  const range = device ? temperatureRange(device) : null;
  if (!device || !range) return;
  const resolved = resolveOverrideDraft(session.draft, range, Date.now(), getHomeyTimezone());
  if (!resolved.ok) {
    session = { ...session, error: resolved.error };
    paint();
    return;
  }
  const targetC = normalizeTargetCapabilityValue({
    target: getPrimaryTargetCapability(device.targets), value: resolved.targetC,
  });
  const done = session.changing ? OVERRIDE_COPY.changed : OVERRIDE_COPY.started;
  void write(session, { untilMs: resolved.untilMs, setting: { type: 'temperature', targetC } }, done);
};

const onEndNow = (): void => {
  if (!session || session.busy) return;
  const active = activeOverride(session, Date.now());
  if (active === null) return;
  void write(session, { ...active, untilMs: Date.now() - CLOCK_ALLOWANCE_MS }, OVERRIDE_COPY.ended);
};

/** Resolve the row for a device; a different device starts from a fresh read. */
export const renderDeviceOverrideCard = (deviceId: string): void => {
  if (session?.deviceId !== deviceId) {
    session = { deviceId, draft: null, changing: false, error: null, busy: false };
    shown = null;
    notify();
    void loadDeviceOverride(deviceId);
    return;
  }
  paint();
};

export const hideDeviceOverrideCard = (): void => {
  session = null;
  shown = null;
  notify();
};

export const deviceOverrideCardActions: DeviceOverrideCardActions = {
  onStart, onEndNow, onDraftChange, onSave, onCancel,
};

document.addEventListener(DEVICE_OVERRIDE_CHANGED_EVENT, (event) => {
  const { deviceId } = (event as CustomEvent<{ deviceId: string }>).detail;
  if (session?.deviceId === deviceId && !session.busy) paint();
});
