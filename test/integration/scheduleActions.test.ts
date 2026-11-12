import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleActionExecutor } from '../../lib/schedules/scheduleActions';
import { ScheduleSkip } from '../../lib/schedules/scheduleSkip';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { SmartTaskCandidateDevice } from '../../packages/contracts/src/smartTaskEdit';
import { partialDouble } from '../helpers/partialDouble';

type ActionHost = ConstructorParameters<typeof ScheduleActionExecutor>[0];

const schedule: Schedule = {
  id: 'charging', name: 'Overnight charging', enabled: true, at: '21:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
  action: { type: 'task', task: {
    deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00',
    exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: true,
  } },
};
const host = () => {
  const objectivesByDeviceId: DeferredObjectiveRoster['objectivesByDeviceId'] = {};
  return {
    resolveSmartTaskHomeScope: vi.fn<ActionHost['resolveSmartTaskHomeScope']>(() => 'main'),
    listTaskDevices: () => [partialDouble<SmartTaskCandidateDevice>({ deviceId: 'charger', deviceName: 'Charger' })],
    getDeferredObjectiveSettings: () => ({ objectivesByDeviceId }),
    upsertDeferredObjectiveForDevice: vi.fn<ActionHost['upsertDeferredObjectiveForDevice']>((deviceId, _name, entry) => {
      objectivesByDeviceId[deviceId] = entry;
      return { persisted: true };
    }),
    handleOperatingModeChange: vi.fn(async () => {}),
  };
};

describe('scheduled action integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-28T20:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('upserts the overnight deadline then grants selected permissions with the schedule source', async () => {
    const commands = host();
    const executor = new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' });
    await executor.execute(schedule, Date.parse('2026-10-28T20:00:00Z'));
    expect(commands.upsertDeferredObjectiveForDevice).toHaveBeenNthCalledWith(1, 'charger', 'Charger', expect.objectContaining({
      kind: 'ev_soc', targetPercent: 80, deadlineAtMs: Date.parse('2026-10-29T06:00:00Z'),
      scheduleSource: { id: 'charging', name: 'Overnight charging' },
    }));
    expect(commands.getDeferredObjectiveSettings().objectivesByDeviceId.charger.rescue).toEqual({
      exemptFromBudget: 'always', pauseLowerPriorityDevices: 'always',
    });
    expect(commands.upsertDeferredObjectiveForDevice).toHaveBeenCalledTimes(3);
    expect(commands.handleOperatingModeChange).not.toHaveBeenCalled();
  });
  it('words an unavailable write for a consumed schedule occurrence', async () => {
    const commands = host();
    commands.upsertDeferredObjectiveForDevice.mockReturnValue({ persisted: false, reason: 'ownership_unavailable' });
    await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(schedule, Date.parse('2026-10-28T20:00:00Z'))).rejects.toThrow('The Smart task could not be saved.');
    expect(commands.upsertDeferredObjectiveForDevice).toHaveBeenCalledTimes(1);
    expect(commands.handleOperatingModeChange).not.toHaveBeenCalled();
  });
  it('invokes one mode command and refuses task devices outside Main', async () => {
    const commands = host();
    const executor = new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' });
    await executor.execute({ ...schedule, action: { type: 'mode', mode: 'Night' } }, Date.now());
    expect(commands.handleOperatingModeChange).toHaveBeenCalledExactlyOnceWith('Night');
    commands.resolveSmartTaskHomeScope.mockReturnValue('sub_home');
    await expect(executor.execute(schedule, Date.now())).rejects.toThrow(ScheduleSkip);
    expect(commands.upsertDeferredObjectiveForDevice).not.toHaveBeenCalled();
  });
  it('words a refused create without its reason code', async () => {
    const commands = host();
    commands.upsertDeferredObjectiveForDevice.mockReturnValue({ persisted: false, reason: 'device_not_planned' });
    await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(schedule, Date.parse('2026-10-28T20:00:00Z'))).rejects.toThrow('PELS does not manage this device.');
  });
  it('rejects a ready-by DST gap without moving the promised same-day deadline to tomorrow', async () => {
    vi.setSystemTime(Date.parse('2026-03-29T00:00:00Z'));
    const commands = host();
    const gap: Schedule = { ...schedule, at: '01:00', action: { type: 'task', task: {
      deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '02:30',
    } } };
    await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(gap, Date.parse('2026-03-29T00:00:00Z'))).rejects.toThrow('does not exist');
    expect(commands.upsertDeferredObjectiveForDevice).not.toHaveBeenCalled();
  });
  it('keeps a following-day deadline on a repeated-clock date instead of choosing the second fold today', async () => {
    vi.setSystemTime(Date.parse('2026-10-25T00:45:00Z'));
    const commands = host();
    const fold: Schedule = { ...schedule, at: '02:45', action: { type: 'task', task: {
      deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '02:30',
    } } };
    await new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(fold, Date.parse('2026-10-25T00:45:00Z'));
    expect(commands.upsertDeferredObjectiveForDevice).toHaveBeenCalledWith('charger', 'Charger', expect.objectContaining({
      deadlineAtMs: Date.parse('2026-10-26T01:30:00Z'),
    }));
  });

  it.each(['2026-10-28T20:01:00Z', '2026-10-28T20:01:30Z'])(
    'skips an elapsed short deadline at %s without creating a task or rolling to tomorrow', async (now) => {
      const commands = host();
      const short: Schedule = { ...schedule, action: { type: 'task', task: {
        deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '21:01',
      } } };
      vi.setSystemTime(Date.parse(now));
      await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
        .execute(short, Date.parse('2026-10-28T20:00:00Z'))).rejects.toThrow('ready-by time had already passed');
      expect(commands.upsertDeferredObjectiveForDevice).not.toHaveBeenCalled();
      expect(commands.handleOperatingModeChange).not.toHaveBeenCalled();
    },
  );

  it('keeps a short same-day deadline while it is still future', async () => {
    const commands = host();
    const short: Schedule = { ...schedule, action: { type: 'task', task: {
      deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '21:01',
    } } };
    vi.setSystemTime(Date.parse('2026-10-28T20:00:30Z'));
    await new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(short, Date.parse('2026-10-28T20:00:00Z'));
    expect(commands.upsertDeferredObjectiveForDevice).toHaveBeenCalledWith('charger', 'Charger', expect.objectContaining({
      deadlineAtMs: Date.parse('2026-10-28T20:01:00Z'),
    }));
  });

  it('refuses an invalid goal before attempting persistence', async () => {
    const commands = host();
    const invalid: Schedule = { ...schedule, action: { type: 'task', task: {
      deviceId: 'charger', kind: 'ev_soc', target: 101, readyByLocalTime: '07:00',
    } } };
    await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(invalid, Date.now())).rejects.toThrow('The task target is invalid.');
    expect(commands.upsertDeferredObjectiveForDevice).not.toHaveBeenCalled();
  });

});
