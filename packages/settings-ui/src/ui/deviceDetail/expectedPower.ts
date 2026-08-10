import type {
  DeviceExpectedPowerOverrides,
  ExpectedPowerOverride,
} from '../../../../contracts/src/types.ts';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../../../contracts/src/settingsKeys.ts';
import { expectedPowerSourceLine } from '../../../../shared-domain/src/expectedPowerCopy.ts';
import { hasSteppedLoadSupport } from '../deviceControlProfiles.ts';
import { supportsPowerDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import {
  deviceDetailExpectedPower,
  deviceDetailExpectedPowerRow,
  deviceDetailExpectedPowerSource,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state, type SettingsUiDeviceView } from '../state.ts';
import { showToast } from '../toast.ts';
import {
  createSerializedAsyncRunner,
  readRecordSetting,
  readRecordSettingStrict,
  writeFreshSetting,
} from './settingsWrite.ts';

const runSerializedExpectedPowerWrite = createSerializedAsyncRunner();

const INVALID_EXPECTED_POWER_MESSAGE = 'Power when running must be a positive number of watts.';

/**
 * Who gets the field.
 *
 * Mirrors the runtime's own refusal (`AppFlowBacked.setExpectedOverride` throws
 * "Stepped load devices use configured planning power per step"): a stepped load
 * is sized per configured step, so one whole-device figure has nothing to apply
 * to. Hidden rather than disabled — the step editor on the same page is where
 * that device's power is described, so there is no switch here to lift.
 */
export const supportsExpectedPowerDevice = (
  device: SettingsUiDeviceDetailItem | null | undefined,
): boolean => (
  supportsPowerDevice(device) && !hasSteppedLoadSupport(device as SettingsUiDeviceView | null)
);

type ExpectedPowerFieldEntry =
  | { kind: 'clear' }
  | { kind: 'set'; kw: number }
  | { kind: 'invalid' };

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
  if (!visible || !device) return;

  // The producer resolves one figure for every device it parses, whichever rung
  // of the ladder wins, so the field shows what PELS is using right now — not
  // only the override. Typing over it is then an edit of a visible number.
  deviceDetailExpectedPower.value = String(Math.round(device.expectedPowerKw * 1000));
  // `expectedPowerSource` is stamped by the same producer and is only ever
  // absent because the contract still declares it optional. Nothing is invented
  // for that case: the line is simply not rendered.
  const sourceLine = device.expectedPowerSource === undefined
    ? ''
    : expectedPowerSourceLine(device.expectedPowerSource);
  deviceDetailExpectedPowerSource.textContent = sourceLine;
  deviceDetailExpectedPowerSource.hidden = sourceLine.length === 0;
};

type ExpectedPowerHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceView | null;
  refreshOpenDeviceDetail: () => void;
};

export const initExpectedPowerHandlers = (deps: ExpectedPowerHandlerDeps) => {
  const persist = async (deviceId: string, entry: { kind: 'clear' } | { kind: 'set'; kw: number }) => {
    await runSerializedExpectedPowerWrite(async () => {
      await writeFreshSetting<DeviceExpectedPowerOverrides>({
        key: DEVICE_EXPECTED_POWER_OVERRIDES,
        context: 'device detail',
        logMessage: 'Failed to save power when running',
        toastMessage: 'Failed to save power when running.',
        // Use the live snapshot as the fallback so a transient null or
        // non-object SDK read does not erase other devices' figures.
        fallbackValue: state.deviceExpectedPowerOverrides,
        // Shape-guard only. Entry validation is the runtime's
        // (`parseExpectedPowerOverrides`), and duplicating it here would mean
        // copying a validator across the settings-UI/runtime boundary the UI
        // may not import across.
        readFresh: (value) => readRecordSettingStrict<ExpectedPowerOverride>(value),
        mutate: (currentOverrides) => {
          const nextOverrides = { ...currentOverrides };
          if (entry.kind === 'set') nextOverrides[deviceId] = { kw: entry.kw, ts: Date.now() };
          else delete nextOverrides[deviceId];
          return nextOverrides;
        },
        commit: (nextOverrides) => {
          state.deviceExpectedPowerOverrides = nextOverrides;
          // No optimistic write onto the device: `expectedPowerKw` is the
          // producer's resolved answer, and the runtime re-parses the snapshot
          // on this settings write. Re-rendering from the device we hold keeps
          // the field honest until that answer arrives.
          deps.refreshOpenDeviceDetail();
        },
        rollback: deps.refreshOpenDeviceDetail,
      });
    });
  };

  deviceDetailExpectedPower?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailExpectedPower) return;
    // Same refusal as the runtime, checked at the moment of the write: a device
    // that became a stepped load while its page was open must not persist a
    // figure the runtime would reject.
    if (!supportsExpectedPowerDevice(deps.getDeviceById(deviceId))) return;
    const entry = readExpectedPowerFieldEntry(deviceDetailExpectedPower.value);
    if (entry.kind === 'invalid') {
      await showToast(INVALID_EXPECTED_POWER_MESSAGE, 'warn');
      deps.refreshOpenDeviceDetail();
      return;
    }
    await persist(deviceId, entry);
  });
};
