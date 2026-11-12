import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDeadlineObjectiveCards } from '../../flowCards/deadlineObjectiveCards';
import { registerAllowSmartTaskRescueCard } from '../../flowCards/smartTaskRescueCard';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectivePlanRevisionBus,
  readAllObjectives,
  readObjectiveForDevice,
  upsertObjectiveForDevice,
} from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveDeviceWriteDeps } from '../../lib/objectives/deferredObjectives/objectiveWrite';
import type { SmartTaskCommandPort } from '../../lib/objectives/deferredObjectives/smartTaskCommands';
import { buildSmartTaskCandidateDevices } from '../../lib/objectives/deferredObjectives/smartTaskCandidateDevices';
import { inactiveTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { ScheduleActionExecutor } from '../../lib/schedules/scheduleActions';
import { ScheduleService } from '../../lib/schedules/scheduleService';
import type { ScheduleReceipt } from '../../lib/schedules/scheduleReceipts';
import type { FlowCard, FlowHomeyLike } from '../../lib/utils/types';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsKind,
} from '../../packages/contracts/src/deferredObjectiveSettings';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import type { CreateSmartTaskCandidateDevice } from '../../packages/contracts/src/widgetHostApi';
import { resolveObjectiveTargetValue } from '../../packages/shared-domain/src/deferredObjectiveValues';
import { partialDouble } from '../helpers/partialDouble';
import { MockSettings } from '../mocks/homey';
import { decoratedSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';

const START_MS = Date.parse('2026-11-11T20:59:00Z');
const OCCURRENCE_MS = Date.parse('2026-11-11T21:00:00Z');
const DEADLINE_MS = Date.parse('2026-11-12T05:00:00Z');
const DEVICE_ID = 'task-device';
const DEVICE_NAME = 'Scheduled device';
const TASK_KEY = `deferred_objective.${DEVICE_ID}`;
const CLOCK = { getTimezone: () => 'Europe/Oslo' };
const services: ScheduleService[] = [];
type RunListener = Parameters<FlowCard['registerRunListener']>[0];
type TaskRequest = Extract<Schedule['action'], { type: 'task' }>['task'];
type PermissionFlags = Pick<TaskRequest, 'exemptFromBudget' | 'limitLowerPriorityDevices' | 'pauseLowerPriorityDevices'>;

const kinds = [
  { kind: 'temperature', target: 85, cardId: 'set_temperature_deadline', args: { target_c: 85 } },
  { kind: 'ev_soc', target: 80, cardId: 'set_ev_charge_deadline', args: { target_percent: 80 } },
  { kind: 'energy', target: 12, cardId: 'set_energy_deadline', args: { target_kwh: 12 } },
] as const;
const permissionProfiles: Array<{ name: string; flags: PermissionFlags; standing: DeferredObjectiveRescuePermissions }> = [
  {
    name: 'budget and pause enabled',
    flags: { exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: true },
    standing: { exemptFromBudget: 'at_risk', limitLowerPriorityDevices: 'at_risk', pauseLowerPriorityDevices: 'at_risk' },
  },
  {
    name: 'limit enabled on a device without steps',
    flags: { exemptFromBudget: false, limitLowerPriorityDevices: true, pauseLowerPriorityDevices: false },
    standing: { exemptFromBudget: 'at_risk', limitLowerPriorityDevices: 'at_risk', pauseLowerPriorityDevices: 'always' },
  },
  {
    name: 'permissions false or absent',
    flags: { exemptFromBudget: false, limitLowerPriorityDevices: false },
    standing: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'at_risk', pauseLowerPriorityDevices: 'always' },
  },
];

function taskEntry(kind: DeferredObjectiveSettingsKind): DeferredObjectiveSettingsEntry {
  const common = { enabled: true, enforcement: 'soft' as const, deadlineAtMs: DEADLINE_MS + 3_600_000 };
  if (kind === 'temperature') return { ...common, kind, targetTemperatureC: 65 };
  if (kind === 'ev_soc') return { ...common, kind, targetPercent: 60 };
  return { ...common, kind, targetEnergyKWh: 5 };
}

function deviceFor(kind: DeferredObjectiveSettingsKind): DecoratedDeviceSnapshot & CreateSmartTaskCandidateDevice {
  const base = decoratedSnapshotFixture({
    id: DEVICE_ID, name: DEVICE_NAME, available: true, targets: [], binaryControl: { on: false },
    isEvCharger: kind === 'ev_soc', expectedPowerKw: 2, expectedPowerSource: 'default',
  });
  if (kind === 'temperature') {
    const target = { id: 'target_temperature' as const, value: 65, unit: '°C', min: 5, max: 95, step: 1 };
    return {
      ...base, deviceType: 'temperature', targets: [target],
      temperature: { currentTemperature: 50, target, intendedTargetC: 65 },
    };
  }
  if (kind === 'ev_soc') return {
    ...base, evChargingState: 'plugged_in', stateOfCharge: stateOfChargeFixture({ percent: 40 }),
  };
  return { ...base, measuredPowerKw: 0, measuredPowerIsDirectMeasurement: true };
}

function fixture(kind: DeferredObjectiveSettingsKind, existing?: DeferredObjectiveSettingsEntry) {
  const settings = new MockSettings();
  if (existing) settings.set(TASK_KEY, structuredClone(existing));
  const snapshot = deviceFor(kind);
  const markPending = vi.fn();
  const finalizeForUserChange = vi.fn();
  const finalizeElapsedDeadline = vi.fn();
  const writeDeps: DeferredObjectiveDeviceWriteDeps = {
    store: settings,
    nowMs: OCCURRENCE_MS + 10_000,
    activePlanRecorder: partialDouble<DeferredObjectiveDeviceWriteDeps['activePlanRecorder']>({ markPending, clearForDevice: vi.fn(), flushIfDirty: vi.fn() }),
    planHistoryRecorder: partialDouble<DeferredObjectiveDeviceWriteDeps['planHistoryRecorder']>({ finalizeForUserChange, finalizeElapsedDeadline, flushIfDirty: vi.fn() }),
    readCurrentTaskEvaluation: (deviceId, objective) => inactiveTaskEvaluation(
      deviceId, objective.deadlineAtMs, resolveObjectiveTargetValue(objective),
    ),
  };
  const upsert = vi.fn<SmartTaskCommandPort['upsertDeferredObjectiveForDevice']>((deviceId, deviceName, entry, rescue) => (
    upsertObjectiveForDevice(writeDeps, deviceId, deviceName, entry, rescue)
  ));
  const host = {
    getDeferredObjectiveSettings: () => readAllObjectives(settings),
    upsertDeferredObjectiveForDevice: upsert,
    resolveSmartTaskHomeScope: vi.fn<() => SmartTaskHomeScope>(() => 'main'),
    handleOperatingModeChange: vi.fn(async () => {}),
    listTaskDevices: () => buildSmartTaskCandidateDevices([snapshot]),
  };
  const actions = new Map<string, RunListener>();
  const card = (id: string): FlowCard => ({
    registerRunListener: (listener) => { actions.set(id, listener); },
    registerArgumentAutocompleteListener: () => {},
  });
  const homey: FlowHomeyLike = { settings, flow: { getActionCard: card, getTriggerCard: card, getConditionCard: card } };
  const flowDeps = partialDouble<FlowCardDeps>({
    ...host, homey, getSnapshot: async () => [snapshot], getNow: () => new Date(),
    getTimeZone: CLOCK.getTimezone,
    deferredObjectivePlanRevisionBus: createDeferredObjectivePlanRevisionBus(),
    deferredObjectiveEndedBus: createDeferredObjectiveEndedBus(),
    deferredObjectiveHoursRemainingBus: createDeferredObjectiveHoursRemainingBus(),
  });
  registerDeadlineObjectiveCards(flowDeps);
  registerAllowSmartTaskRescueCard(flowDeps);
  const receipts = new Map<string, ScheduleReceipt>();
  const executor = new ScheduleActionExecutor(host, CLOCK);
  const execute = vi.fn((schedule: Schedule, atMs: number) => executor.execute(schedule, atMs));
  const service = new ScheduleService({
    settings, clock: CLOCK, timers: new TimerRegistry(), getNowMs: Date.now,
    listModes: () => ['Home'], resolveModeName: (mode) => mode, currentMode: () => 'Home',
    listTaskDevices: host.listTaskDevices, execute,
    receipts: {
      read: (id) => receipts.get(id), write: (id, receipt) => { receipts.set(id, structuredClone(receipt)); },
      delete: (id) => { receipts.delete(id); },
    },
  });
  services.push(service);
  const run = async (id: string, args: unknown) => {
    const listener = actions.get(id);
    if (!listener) throw new Error(`Missing card listener ${id}`);
    return listener(args);
  };
  return { settings, host, executor, service, execute, receipts, upsert, run,
    markPending, finalizeForUserChange, finalizeElapsedDeadline };
}

function scheduleFor(request: TaskRequest): Schedule {
  return {
    id: 'overnight-task', name: 'Overnight task', enabled: true, at: '22:00',
    repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
    action: { type: 'task', task: request },
  };
}

async function runFlow(f: ReturnType<typeof fixture>, task: typeof kinds[number], flags: PermissionFlags) {
  await f.run(task.cardId, { device: DEVICE_ID, ...task.args, ready_by: '06:00' });
  for (const [key, property] of [
    ['exemptFromBudget', 'exempt_from_budget'],
    ['limitLowerPriorityDevices', 'limit_lower_priority'],
    ['pauseLowerPriorityDevices', 'pause_lower_priority'],
  ] as const) {
    if (flags[key]) await f.run('allow_smart_task_rescue', { device: DEVICE_ID, property, when: 'always' });
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START_MS); });
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.useRealTimers();
});

describe('scheduled task and Flow command equivalence', () => {
  for (const task of kinds) {
    for (const hasTask of [false, true]) {
      it.each(permissionProfiles)(`${task.kind}, ${hasTask ? 'open task' : 'no task'}: $name`, async ({ flags, standing }) => {
        const existing = hasTask ? { ...taskEntry(task.kind), rescue: standing } : undefined;
        const scheduled = fixture(task.kind, existing);
        const flow = fixture(task.kind, existing);
        const schedule = scheduleFor({
          deviceId: DEVICE_ID, kind: task.kind, target: task.target, readyByLocalTime: '06:00', ...flags,
        });
        scheduled.settings.set(`schedule.${schedule.id}`, schedule);
        scheduled.service.start();
        vi.setSystemTime(OCCURRENCE_MS + 10_000);
        await scheduled.service.tick();
        await runFlow(flow, task, flags);

        const flowEntry = readObjectiveForDevice(flow.settings, DEVICE_ID);
        expect(flowEntry).toBeDefined();
        expect(readObjectiveForDevice(scheduled.settings, DEVICE_ID)).toEqual({
          ...flowEntry, scheduleSource: { id: schedule.id, name: schedule.name },
        });
        expect(flowEntry?.deadlineAtMs).toBe(DEADLINE_MS);
        for (const permission of ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'] as const) {
          const standingMode = hasTask ? standing[permission] : undefined;
          expect(flowEntry?.rescue?.[permission]).toBe(flags[permission] ? 'always' : standingMode);
        }
        expect(scheduled.markPending).toHaveBeenCalledOnce();
        expect(scheduled.markPending).toHaveBeenCalledWith(expect.objectContaining({ deviceName: DEVICE_NAME }), expect.any(Number));
        expect(scheduled.finalizeForUserChange).toHaveBeenCalledTimes(hasTask ? 1 : 0);
        expect(scheduled.finalizeForUserChange.mock.calls).toEqual(flow.finalizeForUserChange.mock.calls);
        if (hasTask) expect(scheduled.finalizeForUserChange).toHaveBeenCalledWith(
          DEVICE_ID, OCCURRENCE_MS + 10_000, 'replaced', expect.any(Object),
        );
        expect(scheduled.upsert).toHaveBeenCalledTimes(flow.upsert.mock.calls.length);
        expect(scheduled.receipts.get(schedule.id)?.lastResult).toBe('Smart task created.');
        expect(scheduled.service.read().entries[0]?.lastResult).toBe('Smart task created.');
        const writes = scheduled.upsert.mock.calls.length;
        vi.setSystemTime(OCCURRENCE_MS + 7 * 60_000);
        await scheduled.service.tick();
        expect(scheduled.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: schedule.id }), OCCURRENCE_MS);
        expect(scheduled.upsert).toHaveBeenCalledTimes(writes);
      });
    }
  }

  it.each([
    { state: 'paused future task', enabled: false, deadlineAtMs: DEADLINE_MS, elapsed: false },
    { state: 'enabled elapsed task', enabled: true, deadlineAtMs: START_MS - 1, elapsed: true },
    { state: 'disabled elapsed task', enabled: false, deadlineAtMs: START_MS - 1, elapsed: false },
  ])('replaces a $state with the same recorder lifecycle as the cards', async ({ enabled, deadlineAtMs, elapsed }) => {
    const existing = { ...taskEntry('temperature'), enabled, deadlineAtMs };
    const scheduled = fixture('temperature', existing);
    const flow = fixture('temperature', existing);
    vi.setSystemTime(OCCURRENCE_MS + 10_000);
    const schedule = scheduleFor({ deviceId: DEVICE_ID, kind: 'temperature', target: 85, readyByLocalTime: '06:00' });
    await scheduled.executor.execute(schedule, OCCURRENCE_MS);
    await runFlow(flow, kinds[0], {});
    expect(scheduled.finalizeElapsedDeadline.mock.calls).toEqual(flow.finalizeElapsedDeadline.mock.calls);
    expect(scheduled.finalizeElapsedDeadline).toHaveBeenCalledTimes(elapsed ? 1 : 0);
    expect(scheduled.finalizeForUserChange).not.toHaveBeenCalled();
    expect(scheduled.markPending.mock.calls).toEqual(flow.markPending.mock.calls);
  });

  it('refuses an unreadable listed task without replacing its stored bytes', async () => {
    const f = fixture('temperature');
    f.settings.set(TASK_KEY, null);
    vi.setSystemTime(OCCURRENCE_MS + 10_000);
    await expect(f.executor.execute(scheduleFor({
      deviceId: DEVICE_ID, kind: 'temperature', target: 85, readyByLocalTime: '06:00',
    }), OCCURRENCE_MS)).rejects.toThrow('The Smart task could not be saved.');
    expect(f.settings.get(TASK_KEY)).toBeNull();
    expect(f.markPending).not.toHaveBeenCalled();
  });

  it('keeps the deadline write and records failure if a later permission write refuses, without retrying', async () => {
    const f = fixture('temperature', taskEntry('temperature'));
    const schedule = scheduleFor({
      deviceId: DEVICE_ID, kind: 'temperature', target: 85, readyByLocalTime: '06:00', exemptFromBudget: true,
    });
    const normalWrite = f.upsert.getMockImplementation();
    if (!normalWrite) throw new Error('Missing objective writer');
    f.upsert.mockImplementationOnce(normalWrite).mockReturnValueOnce({ persisted: false, reason: 'untrusted_absence' });
    f.settings.set(`schedule.${schedule.id}`, schedule);
    f.service.start();
    vi.setSystemTime(OCCURRENCE_MS + 10_000);
    await f.service.tick();
    expect(readObjectiveForDevice(f.settings, DEVICE_ID)).toMatchObject({ targetTemperatureC: 85, deadlineAtMs: DEADLINE_MS });
    expect(f.receipts.get(schedule.id)?.lastResult).toBe(
      'Could not run. The Smart task was saved, but an extra permission could not be saved.',
    );
    vi.setSystemTime(OCCURRENCE_MS + 7 * 60_000);
    await f.service.tick();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.upsert).toHaveBeenCalledTimes(2);
  });
});
