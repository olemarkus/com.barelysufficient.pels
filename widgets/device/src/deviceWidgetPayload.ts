import {
  DEVICE_WIDGET_RUNNING_NOW,
  formatDeviceWidgetNextRun,
} from '../../../packages/shared-domain/src/smartTaskCopy/widgetCopy';
import { formatLocalHHMM } from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildSmartTaskCandidateDevices } from '../../../lib/objectives/deferredObjectives';
import { readActiveDeviceOverride } from '../../../lib/overrides/deviceOverrides';
import type { SettingsPort } from '../../../lib/ports/homeyRuntime';
import type { SettingsUiPlanDeviceSnapshot } from '../../../packages/contracts/src/settingsUi/plan';
import type { TargetCapabilitySnapshot } from '../../../packages/contracts/src/types';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import type { OverrideTemperatureRange } from '../../../packages/shared-domain/src/settings/deviceOverrideDraft';
import { getTemperatureTargetCapability } from '../../../packages/shared-domain/src/targetCapabilities';
import type { PelsHost } from '../../../lib/app/pelsHost';
import {
  buildSmartTaskDeviceView,
  ENDED_WINDOW_MS,
  type SmartTaskDeviceView,
  type SmartTaskRunTiming,
} from '../../smart_tasks/src/smartTasksWidgetPayload';
import type { DeviceWidgetOverride, DeviceWidgetPayload, DeviceWidgetTask } from './deviceWidgetTypes';

// The Device insight widget's read for one device. It runs no planner: it reads the
// plan snapshot published for the UI (with each device's resolved status) and
// assembles the same read models the Smart task list and Create smart task widgets
// serve (active plans, recent history, creation candidates), filtered to one
// device. Its cost per read is theirs, once a minute per tile.

const resolveRunLabel = (run: SmartTaskRunTiming, timeZone: string | null): string | null => {
  if (run.kind === 'running_now') return DEVICE_WIDGET_RUNNING_NOW;
  return run.kind === 'next' ? formatDeviceWidgetNextRun(formatLocalHHMM(run.startsAtMs, timeZone)) : null;
};

const toTask = (view: SmartTaskDeviceView, timeZone: string | null): DeviceWidgetTask => {
  if (view.active) {
    const { row, statusId, run } = view.active;
    // A queued task's why line already says when its cheaper hours start.
    return { kind: 'active', row, nextRunLabel: statusId === 'queued' ? null : resolveRunLabel(run, timeZone) };
  }
  return view.endedToday ? { kind: 'ended', row: view.endedToday } : { kind: 'none' };
};

/** Resolve the same temperature-command authority for widget reads and commands. */
export const readDeviceWidgetOverrideTarget = (
  host: PelsHost,
  deviceId: string,
): TargetCapabilitySnapshot | undefined => {
  const device = host.getSettingsUiManagedDevices().find((entry) => entry.id === deviceId);
  if (!device?.managed || device.deviceType !== 'temperature' || device.isBatteryOrSolar
    || host.deviceControlSettings.isTemperatureControlDisabled(deviceId, device)) return undefined;
  return getTemperatureTargetCapability(device.targets);
};

export const deviceWidgetOverrideRange = (target: TargetCapabilitySnapshot): OverrideTemperatureRange => ({
  min: isFiniteNumber(target.min) ? target.min : null,
  max: isFiniteNumber(target.max) ? target.max : null,
});

const buildOverride = (
  host: PelsHost,
  settings: Pick<SettingsPort, 'get'> | undefined,
  planDevice: SettingsUiPlanDeviceSnapshot,
  nowMs: number,
  timeZone: string | null,
  taskDeadlineAtMs: number | null,
): DeviceWidgetOverride | null => {
  if (!settings || timeZone === null || planDevice.status.cardKind !== 'temperature') return null;
  const deviceId = planDevice.id;
  const target = readDeviceWidgetOverrideTarget(host, deviceId);
  if (!target) return null;
  const observedTemperature = isFiniteNumber(target.value) ? target.value : null;
  return {
    active: readActiveDeviceOverride(settings, deviceId, nowMs),
    range: deviceWidgetOverrideRange(target),
    defaultTemperatureC: host.readGoverningModeTargetC(deviceId) ?? observedTemperature,
    timeZone,
    taskDeadlineAtMs,
  };
};

const activeTaskDeadline = (
  activePlans: ReturnType<PelsHost['getDeferredObjectiveActivePlansUiPayload']>,
  deviceId: string,
  task: DeviceWidgetTask,
): number | null => (
  task.kind === 'active' ? activePlans?.plansByDeviceId[deviceId]?.deadlineAtMs ?? null : null
);

export const buildDeviceWidgetPayload = (
  host: PelsHost,
  deviceId: string,
  nowMs: number,
  timeZone: string | null,
  settings: Pick<SettingsPort, 'get'> | undefined,
): DeviceWidgetPayload => {
  const plan = host.getLatestPlanSnapshotForUi();
  if (plan === null) return { state: 'starting' };
  const planDevice = plan.devices?.find((device) => device.id === deviceId);
  if (!planDevice) return { state: 'not_managed' };
  const activePlans = host.getDeferredObjectiveActivePlansUiPayload();
  const view = buildSmartTaskDeviceView({
    activePlans,
    history: host.getDeferredObjectivePlanHistoryRecentUiPayload(nowMs - ENDED_WINDOW_MS),
    devices: host.getUiPickerDevices(),
    nowMs,
    timeZone,
  }, deviceId);
  const task = toTask(view, timeZone);
  // Any open task, a satisfied one included, rules out a new one: the create
  // would replace it.
  const candidates = view.active === null ? host.getCreateSmartTaskCandidateDevices() : null;
  const [createDevice] = candidates?.state === 'ready'
    ? buildSmartTaskCandidateDevices(candidates.devices.filter((device) => device.id === deviceId))
    : [];
  return {
    state: 'ready',
    device: {
      id: planDevice.id,
      name: planDevice.name,
      status: planDevice.status,
      carName: host.deviceManager?.getAssociatedCar(deviceId)?.carName ?? null,
    },
    task,
    override: buildOverride(
      host, settings, planDevice, nowMs, timeZone, activeTaskDeadline(activePlans, deviceId, task),
    ),
    createDevice: createDevice ?? null,
  };
};

// The devices the widget's "Device" setting offers: the ones in PELS's plan,
// by name, filtered by what the user typed.
export const buildDeviceWidgetChoices = (
  host: Pick<PelsHost, 'getLatestPlanSnapshotForUi'>,
  query: string,
): Array<{ id: string; name: string }> => {
  const needle = query.trim().toLowerCase();
  return (host.getLatestPlanSnapshotForUi()?.devices ?? [])
    .filter((device) => needle === '' || device.name.toLowerCase().includes(needle))
    .map((device) => ({ id: device.id, name: device.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
