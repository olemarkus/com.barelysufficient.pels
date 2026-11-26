import type {
  DeviceExpectedPowerOverrides,
  ExpectedPowerOverride,
} from '../../../../contracts/src/types.ts';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { expectedPowerSourceLine } from '../../../../shared-domain/src/expectedPowerCopy.ts';
import { isLastResortConfigured } from '../devicePowerSetup.ts';
import { isSteppedLoadProfileActive } from '../deviceControlProfiles.ts';
import { supportsPowerDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import {
  deviceDetailExpectedPower,
  deviceDetailExpectedPowerRow,
  deviceDetailExpectedPowerSource,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { findLatestDevice, state, type SettingsUiDeviceView } from '../state.ts';
import { showToast } from '../toast.ts';
import {
  createSerializedAsyncRunner,
  readRecordSetting,
  readRecordSettingStrict,
  writeFreshSetting,
} from './settingsWrite.ts';

const runSerializedExpectedPowerWrite = createSerializedAsyncRunner();

const EXPECTED_POWER_SNAPSHOT_WAIT_MS = 12000;

const INVALID_EXPECTED_POWER_MESSAGE = 'Power when running must be a positive number of watts.';

/**
 * Who gets the field.
 *
 * Mirrors the runtime's own refusal (`FlowBackedDeviceState.setExpectedOverride` throws
 * "Stepped load devices use configured planning power per step"): a stepped load
 * is sized per configured step, so one whole-device figure has nothing to apply
 * to. Hidden rather than disabled — the step editor on the same page is where
 * that device's power is described, so there is no switch here to lift.
 *
 * The refusal turns on a profile that is ACTIVE, not on one that is merely
 * suggested, so this asks the same question. A native device whose stepped
 * activation is off — or whose owner switched the control model back to Default
 * — is binary-controlled, the runtime WILL take its figure, and hiding the field
 * would leave the owner nothing to correct the estimate with.
 */
export const supportsExpectedPowerDevice = (
  device: SettingsUiDeviceDetailItem | null | undefined,
): boolean => (
  Boolean(device && supportsPowerDevice(device) && !isSteppedLoadProfileActive(device)
    && !isLastResortConfigured(device.id))
);

type ExpectedPowerEdit =
  | { kind: 'clear' }
  | { kind: 'set'; kw: number };

type PendingExpectedPowerEdit = {
  edit: ExpectedPowerEdit;
  /** Once storage acknowledges the write, bound the wait for the runtime snapshot. */
  snapshotTimer?: number;
};

const pendingEdits = new Map<string, PendingExpectedPowerEdit>();

const clearPendingEdit = (deviceId: string): void => {
  window.clearTimeout(pendingEdits.get(deviceId)?.snapshotTimer);
  pendingEdits.delete(deviceId);
};

type ExpectedPowerFieldEntry = ExpectedPowerEdit | { kind: 'invalid' };

const snapshotConfirmsEdit = (device: SettingsUiDeviceView, edit: ExpectedPowerEdit): boolean => (
  edit.kind === 'clear'
    ? device.expectedPowerSource !== 'manual'
    : device.expectedPowerSource === 'manual' && formatWatts(device.expectedPowerKw) === formatWatts(edit.kw)
);

const formatWatts = (kw: number): string => String(Math.round(kw * 1000));

/**
 * What the owner typed, as one of three answers rather than a nullable number:
 * an empty box means "let PELS work it out" and must delete the entry, while a
 * zero or a stray character means the write should not happen at all. Collapsing
 * those two into `null` would silently clear an override on a typo.
 */
const readExpectedPowerFieldEntry = (raw: string): ExpectedPowerFieldEntry => {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'clear' };
  const watts = Number(trimmed);
  if (!Number.isFinite(watts) || watts <= 0) return { kind: 'invalid' };
  return { kind: 'set', kw: watts / 1000 };
};

export const loadDeviceExpectedPowerOverrides = async () => {
  try {
    state.deviceExpectedPowerOverrides = readRecordSetting<ExpectedPowerOverride>(
      await getSetting(DEVICE_EXPECTED_POWER_OVERRIDES),
    );
  } catch (error) {
    await logSettingsError(
      'Failed to load expected power overrides',
      error,
      'loadDeviceExpectedPowerOverrides',
    );
    state.deviceExpectedPowerOverrides = {};
  }
};

export const renderExpectedPowerField = (device: SettingsUiDeviceView | null) => {
  if (!deviceDetailExpectedPowerRow || !deviceDetailExpectedPower || !deviceDetailExpectedPowerSource) {
    return;
  }
  const visible = supportsExpectedPowerDevice(device);
  deviceDetailExpectedPowerRow.hidden = !visible;
  if (!device) return;
  if (!visible) {
    clearPendingEdit(device.id);
    return;
  }

  const pending = pendingEdits.get(device.id);
  if (pending) {
    // A settings write can repaint this page before the runtime has re-parsed
    // its devices. Keep the edit visible without attributing it to that snapshot.
    if (pending.snapshotTimer === undefined || !snapshotConfirmsEdit(device, pending.edit)) {
      deviceDetailExpectedPower.value = pending.edit.kind === 'clear' ? '' : formatWatts(pending.edit.kw);
      deviceDetailExpectedPowerSource.hidden = true;
      return;
    }
    clearPendingEdit(device.id);
  }

  deviceDetailExpectedPower.value = formatWatts(device.expectedPowerKw);
  // `expectedPowerSource` is stamped by the same producer and is REQUIRED on the
  // contract, so there is no absent case to render around: every device has a
  // rung, and the line always says which one is answering.
  deviceDetailExpectedPowerSource.textContent = expectedPowerSourceLine(device.expectedPowerSource);
  deviceDetailExpectedPowerSource.hidden = false;
};

type ExpectedPowerHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
};

/** Save or clear one device's figure, serialized with every write of the record. */
const persistExpectedPowerEntry = (deviceId: string, edit: ExpectedPowerEdit) => (
  runSerializedExpectedPowerWrite(() => writeFreshSetting<DeviceExpectedPowerOverrides>({
    key: DEVICE_EXPECTED_POWER_OVERRIDES,
    context: 'device detail',
    logMessage: 'Failed to save power when running',
    toastMessage: 'Failed to save power when running.',
    // Use the live snapshot as the fallback so a transient null or
    // non-object SDK read does not erase other devices' figures.
    fallbackValue: state.deviceExpectedPowerOverrides,
    // Shape-guard only. The runtime validates the entries.
    readFresh: readRecordSettingStrict<ExpectedPowerOverride>,
    mutate: (currentOverrides) => {
      const nextOverrides = { ...currentOverrides };
      if (edit.kind === 'set') nextOverrides[deviceId] = { kw: edit.kw, ts: Date.now(), origin: 'settings' };
      else delete nextOverrides[deviceId];
      return nextOverrides;
    },
    commit: (nextOverrides) => {
      state.deviceExpectedPowerOverrides = nextOverrides;
    },
  }))
);

/** The "Use X kW" recommendation's write: the same record and path as typing the figure on the device page. */
export const saveExpectedPowerFigure = async (deviceId: string, kw: number): Promise<void> => {
  clearPendingEdit(deviceId);
  await persistExpectedPowerEntry(deviceId, { kind: 'set', kw });
};

export const initExpectedPowerHandlers = (deps: ExpectedPowerHandlerDeps) => {
  const refreshEdit = (deviceId: string) => {
    if (deps.getCurrentDetailDeviceId() === deviceId) deps.refreshOpenDeviceDetail();
  };

  const persist = async (deviceId: string, edit: ExpectedPowerEdit) => {
    clearPendingEdit(deviceId);
    const saving: PendingExpectedPowerEdit = { edit };
    pendingEdits.set(deviceId, saving);
    refreshEdit(deviceId);

    const saved = await persistExpectedPowerEntry(deviceId, edit);
    if (pendingEdits.get(deviceId) !== saving) return;
    if (saved === null) {
      pendingEdits.delete(deviceId);
    } else {
      const waiting: PendingExpectedPowerEdit = {
        edit,
        snapshotTimer: window.setTimeout(() => {
          if (pendingEdits.get(deviceId) !== waiting) return;
          pendingEdits.delete(deviceId);
          refreshEdit(deviceId);
        }, EXPECTED_POWER_SNAPSHOT_WAIT_MS),
      };
      pendingEdits.set(deviceId, waiting);
    }
    refreshEdit(deviceId);
  };

  deviceDetailExpectedPower?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailExpectedPower) return;
    // Same refusal as the runtime, checked at the moment of the write: a device
    // that became a stepped load while its page was open must not persist a
    // figure the runtime would reject.
    if (!supportsExpectedPowerDevice(findLatestDevice(deviceId))) return;
    const entry = readExpectedPowerFieldEntry(deviceDetailExpectedPower.value);
    if (entry.kind === 'invalid') {
      await showToast(INVALID_EXPECTED_POWER_MESSAGE, 'warn');
      deps.refreshOpenDeviceDetail();
      return;
    }
    await persist(deviceId, entry);
  });
};
