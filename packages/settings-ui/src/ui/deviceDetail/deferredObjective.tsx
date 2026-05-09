import { render } from 'preact';
import {
  createEmptyDeferredObjectiveSettings,
  DEFERRED_OBJECTIVES_SETTINGS_VERSION,
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveTemperatureSettingsEntry,
} from '../../../../contracts/src/deferredObjectiveSettings.ts';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../../../../contracts/src/settingsKeys.ts';
import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import { getPrimaryTargetCapability } from '../../../../contracts/src/targetCapabilities.ts';
import { deviceDetailDeadlineObjectiveMount } from '../dom.ts';
import { getSetting, getSettingFresh, setSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { showToast, showToastError } from '../toast.ts';
import { supportsTemperatureDevice } from '../deviceUtils.ts';
import { DeviceDeadlineObjectiveCard } from '../views/DeviceDeadlineObjectiveCard.tsx';

type RawDeferredObjectiveSettings = {
  version: typeof DEFERRED_OBJECTIVES_SETTINGS_VERSION;
  objectivesByDeviceId: Record<string, unknown>;
};

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

let savingDeviceId: string | null = null;
let cardError: string | null = null;

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readDeferredObjectiveSettingsForWrite = async (): Promise<RawDeferredObjectiveSettings> => {
  const raw = await getSettingFresh(DEFERRED_OBJECTIVES_SETTINGS);
  if (raw === undefined || raw === null) {
    return createEmptyDeferredObjectiveSettings();
  }
  if (!isObjectRecord(raw)) {
    throw new Error('Stored deadline target settings have an unexpected shape.');
  }
  if (raw.version !== DEFERRED_OBJECTIVES_SETTINGS_VERSION) {
    throw new Error('Stored deadline target settings use an unsupported version.');
  }
  if (!isObjectRecord(raw.objectivesByDeviceId)) {
    throw new Error('Stored deadline target entries have an unexpected shape.');
  }
  return {
    version: DEFERRED_OBJECTIVES_SETTINGS_VERSION,
    objectivesByDeviceId: { ...raw.objectivesByDeviceId },
  };
};

export const loadDeferredObjectiveSettings = async (): Promise<void> => {
  const raw = await getSetting(DEFERRED_OBJECTIVES_SETTINGS);
  state.deferredObjectiveSettings = normalizeDeferredObjectiveSettings(raw);
};

const getTemperatureEntry = (
  settings: DeferredObjectiveSettingsV1,
  deviceId: string,
): DeferredObjectiveTemperatureSettingsEntry | null => {
  const entry = settings.objectivesByDeviceId[deviceId];
  return entry?.kind === 'temperature' ? entry : null;
};

const canShowDeadlineObjectiveCard = (device: TargetDeviceSnapshot): boolean => (
  state.canToggleOverviewRedesign
  && supportsTemperatureDevice(device)
  && getPrimaryTargetCapability(device.targets) !== null
);

const buildDeadlinePlanHref = (deviceId: string): string => (
  `./deadline-plan.html?deviceId=${encodeURIComponent(deviceId)}`
);

const validateDeadlineObjectiveForm = (params: {
  targetTemperatureC: number;
  deadlineLocalTime: string;
  min: number;
  max: number;
}): string | null => {
  if (!Number.isFinite(params.targetTemperatureC)) {
    return 'Enter a target temperature.';
  }
  if (params.targetTemperatureC < params.min || params.targetTemperatureC > params.max) {
    return `Target temperature must be between ${params.min} and ${params.max} °C.`;
  }
  if (!LOCAL_TIME_PATTERN.test(params.deadlineLocalTime)) {
    return 'Enter a valid time.';
  }
  return null;
};

const saveTemperatureObjective = async (params: {
  device: TargetDeviceSnapshot;
  enabled: boolean;
  targetTemperatureC: number;
  deadlineLocalTime: string;
}): Promise<void> => {
  const target = getPrimaryTargetCapability(params.device.targets);
  const min = typeof target?.min === 'number' && Number.isFinite(target.min) ? target.min : -50;
  const max = typeof target?.max === 'number' && Number.isFinite(target.max) ? target.max : 100;
  const validationError = validateDeadlineObjectiveForm({
    targetTemperatureC: params.targetTemperatureC,
    deadlineLocalTime: params.deadlineLocalTime,
    min,
    max,
  });
  if (validationError) {
    cardError = validationError;
    renderDeviceDeadlineObjectiveCard(params.device);
    return;
  }

  savingDeviceId = params.device.id;
  cardError = null;
  renderDeviceDeadlineObjectiveCard(params.device);
  try {
    const current = await readDeferredObjectiveSettingsForWrite();
    current.objectivesByDeviceId[params.device.id] = {
      enabled: params.enabled,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: params.targetTemperatureC,
      deadlineLocalTime: params.deadlineLocalTime,
    };
    await setSetting(DEFERRED_OBJECTIVES_SETTINGS, current);
    state.deferredObjectiveSettings = normalizeDeferredObjectiveSettings(current);
    await showToast('Deadline target saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save deadline target', error, 'deviceDeadlineObjective');
    await showToastError(error, 'Failed to save deadline target.');
  } finally {
    savingDeviceId = null;
    renderDeviceDeadlineObjectiveCard(params.device);
  }
};

const clearTemperatureObjective = async (device: TargetDeviceSnapshot): Promise<void> => {
  savingDeviceId = device.id;
  cardError = null;
  renderDeviceDeadlineObjectiveCard(device);
  try {
    const current = await readDeferredObjectiveSettingsForWrite();
    delete current.objectivesByDeviceId[device.id];
    await setSetting(DEFERRED_OBJECTIVES_SETTINGS, current);
    state.deferredObjectiveSettings = normalizeDeferredObjectiveSettings(current);
    await showToast('Deadline target cleared.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to clear deadline target', error, 'deviceDeadlineObjective');
    await showToastError(error, 'Failed to clear deadline target.');
  } finally {
    savingDeviceId = null;
    renderDeviceDeadlineObjectiveCard(device);
  }
};

export const renderDeviceDeadlineObjectiveCard = (device: TargetDeviceSnapshot | null): void => {
  if (!deviceDetailDeadlineObjectiveMount) return;
  if (!device || !canShowDeadlineObjectiveCard(device)) {
    render(null, deviceDetailDeadlineObjectiveMount);
    return;
  }

  render(
    <DeviceDeadlineObjectiveCard
      key={device.id}
      deviceName={device.name}
      entry={getTemperatureEntry(state.deferredObjectiveSettings, device.id)}
      planHref={buildDeadlinePlanHref(device.id)}
      target={getPrimaryTargetCapability(device.targets)}
      saving={savingDeviceId === device.id}
      error={cardError}
      onSave={(params) => {
        void saveTemperatureObjective({ device, ...params });
      }}
      onClear={() => {
        void clearTemperatureObjective(device);
      }}
    />,
    deviceDetailDeadlineObjectiveMount,
  );
};
