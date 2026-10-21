import {
  DEVICE_WIDGET_RUNNING_NOW,
  formatDeviceWidgetNextRun,
} from '../../../packages/shared-domain/src/deadlineLabels';
import { formatLocalHHMM } from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildSmartTaskCandidateDevices } from '../../../lib/objectives/deferredObjectives';
import type { PelsHost } from '../../../lib/app/pelsHost';
import {
  buildSmartTaskDeviceView,
  ENDED_WINDOW_MS,
  type SmartTaskDeviceView,
  type SmartTaskRunTiming,
} from '../../smart_tasks/src/smartTasksWidgetPayload';
import type { DeviceWidgetPayload, DeviceWidgetTask } from './deviceWidgetTypes';

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

export const buildDeviceWidgetPayload = (
  host: PelsHost,
  deviceId: string,
  nowMs: number,
  timeZone: string | null,
): DeviceWidgetPayload => {
  const plan = host.getLatestPlanSnapshotForUi();
  if (plan === null) return { state: 'starting' };
  const planDevice = plan.devices?.find((device) => device.id === deviceId);
  if (!planDevice) return { state: 'not_managed' };
  const view = buildSmartTaskDeviceView({
    activePlans: host.getDeferredObjectiveActivePlansUiPayload(),
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
