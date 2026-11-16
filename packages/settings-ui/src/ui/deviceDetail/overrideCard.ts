import { h, render } from 'preact';
import {
  deviceOverrideKey, isDeviceOverrideInForce, parseDeviceOverride, type DeviceOverride,
} from '../../../../shared-domain/src/settings/deviceOverrides.ts';
import {
  getPrimaryTargetCapability, normalizeTargetCapabilityValue,
} from '../../../../shared-domain/src/targetCapabilities.ts';
import { resolveTemperatureControlMode } from '../../../../shared-domain/src/settings/temperatureControl.ts';
import {
  OVERRIDE_COPY, formatActiveOverride, newOverrideDraft, resolveOverrideDraft, type OverrideDraft,
  type OverrideTemperatureRange,
} from '../deviceOverrideDraft.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { getHomeyTimezone, getSetting, setSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { resolveManagedState, state } from '../state.ts';
import { getTargetCapabilityStep } from '../targetCapabilityStep.ts';
import { showToast, showToastError } from '../toast.ts';
import { DeviceOverrideCard, type DeviceOverrideCardState } from '../views/DeviceOverrideCard.tsx';

/**
 * The device page's Override card, first on a managed thermostat's page: start
 * a temperature override, see the one in force, end it early.
 *
 * The card writes the device's `device_override.<deviceId>` key through the
 * settings bridge and reads it back the same way; the runtime owner
 * (`lib/overrides/deviceOverrides.ts`) decides what the plan does with it.
 * Ending early stores an end time of now.
 */
type CardSession = {
  deviceId: string;
  /** The stored override, in force or not; `null` until read, or when none is stored. */
  override: DeviceOverride | null;
  draft: OverrideDraft | null;
  error: string | null;
  busy: boolean;
};

let session: CardSession | null = null;
let readGeneration = 0;

const root = (): HTMLElement | null => document.getElementById('device-detail-override');

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
  current.override !== null && isDeviceOverrideInForce(current.override, nowMs) ? current.override : null
);

const resolveCardState = (current: CardSession, device: SettingsUiDeviceDetailItem): DeviceOverrideCardState | null => {
  const range = temperatureRange(device);
  if (range === null) return null;
  const mode = resolveTemperatureControlMode(
    state.temperatureControlModes, state.temperatureControlDisabledMap, device.id,
  );
  if (mode === 'external') return { kind: 'blocked' };
  if (current.draft !== null) {
    return { kind: 'editing', draft: current.draft, range, error: current.error, busy: current.busy };
  }
  const nowMs = Date.now();
  const active = activeOverride(current, nowMs);
  if (active === null) return { kind: 'idle' };
  return { kind: 'active', line: formatActiveOverride(active, nowMs, getHomeyTimezone()), busy: current.busy };
};

const paint = (): void => {
  const el = root();
  if (!el || !session) return;
  const device = findDevice(session.deviceId);
  const applies = device !== undefined && supportsTemperatureDevice(device) && resolveManagedState(device.id);
  const cardState = applies ? resolveCardState(session, device) : null;
  if (cardState === null) {
    el.hidden = true;
    return;
  }
  const actions = { onStart, onEndNow, onDraftChange, onSave, onCancel };
  render(h(DeviceOverrideCard, { state: cardState, actions }), el);
  el.hidden = false;
};

const readOverride = async (deviceId: string): Promise<void> => {
  readGeneration += 1;
  const generation = readGeneration;
  let override: DeviceOverride | null = null;
  try {
    override = parseDeviceOverride(await getSetting(deviceOverrideKey(deviceId)));
  } catch (error) {
    void logSettingsError('Failed to read device override', error, 'device override');
  }
  if (generation !== readGeneration || session?.deviceId !== deviceId) return;
  session = { ...session, override };
  paint();
};

const onStart = (): void => {
  if (!session) return;
  const device = findDevice(session.deviceId);
  if (!device) return;
  const nowMs = Date.now();
  const active = activeOverride(session, nowMs);
  const target = getPrimaryTargetCapability(device.targets);
  const currentC = active?.setting.targetC ?? (typeof target?.value === 'number' ? target.value : null);
  session = { ...session, draft: newOverrideDraft(currentC, nowMs, getHomeyTimezone()), error: null };
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
    await setSetting(deviceOverrideKey(current.deviceId), override);
    if (session?.deviceId !== current.deviceId) return;
    session = { ...session, override, draft: null, busy: false };
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
  void write(session, { untilMs: resolved.untilMs, setting: { type: 'temperature', targetC } }, OVERRIDE_COPY.started);
};

const onEndNow = (): void => {
  if (!session || session.busy) return;
  const active = activeOverride(session, Date.now());
  if (active === null) return;
  void write(session, { ...active, untilMs: Date.now() }, OVERRIDE_COPY.ended);
};

/** Paint the card for a device; a different device starts from a fresh read. */
export const renderDeviceOverrideCard = (deviceId: string): void => {
  if (session?.deviceId !== deviceId) {
    session = { deviceId, override: null, draft: null, error: null, busy: false };
    const el = root();
    if (el) el.hidden = true;
    void readOverride(deviceId);
    return;
  }
  paint();
};

export const hideDeviceOverrideCard = (): void => {
  readGeneration += 1;
  session = null;
  const el = root();
  if (el) el.hidden = true;
};

/** A Flow or another session changed the open device's override. */
export const notifyDeviceOverrideSettingChanged = (key: string): void => {
  if (session && key === deviceOverrideKey(session.deviceId) && !session.busy) void readOverride(session.deviceId);
};
