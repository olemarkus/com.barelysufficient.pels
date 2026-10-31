import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleActionExecutor } from '../../lib/schedules/scheduleActions';
import { ScheduleSkip } from '../../lib/schedules/scheduleSkip';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { SmartTaskCreateLaneHost } from '../../lib/objectives/deferredObjectives/smartTaskCreateLane';

const schedule: Schedule = {
  id: 'charging', name: 'Overnight charging', enabled: true, at: '21:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
  action: { type: 'task', task: {
    deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00',
    exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: true,
  } },
};
const host = () => ({
  resolveSmartTaskHomeScope: vi.fn<SmartTaskCreateLaneHost['resolveSmartTaskHomeScope']>(() => 'main'),
  previewDeferredObjectivePlan: vi.fn<SmartTaskCreateLaneHost['previewDeferredObjectivePlan']>(),
  createNewDeferredObjective: vi.fn<SmartTaskCreateLaneHost['createNewDeferredObjective']>(() => ({ ok: true })),
  handleOperatingModeChange: vi.fn(async () => {}),
});

describe('scheduled action integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-28T20:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('uses the existing fresh-task write with an overnight deadline, explicit permissions and source', async () => {
    const commands = host();
    const executor = new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' });
    await executor.execute(schedule, Date.parse('2026-10-28T20:00:00Z'));
    expect(commands.createNewDeferredObjective).toHaveBeenCalledWith('charger', expect.objectContaining({
      kind: 'ev_soc', targetPercent: 80, deadlineAtMs: Date.parse('2026-10-29T06:00:00Z'),
      scheduleSource: { id: 'charging', name: 'Overnight charging' },
      rescue: { exemptFromBudget: 'always', pauseLowerPriorityDevices: 'always' },
    }));
    expect(commands.handleOperatingModeChange).not.toHaveBeenCalled();
  });
  it('reports an existing task without replacing it or changing mode', async () => {
    const commands = host();
    commands.createNewDeferredObjective.mockReturnValue({ ok: false, reason: 'task_exists' });
    await expect(new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(schedule, Date.parse('2026-10-28T20:00:00Z'))).rejects.toMatchObject({ deviceBusy: true });
    expect(commands.createNewDeferredObjective).toHaveBeenCalledTimes(1);
    expect(commands.handleOperatingModeChange).not.toHaveBeenCalled();
  });
  it('invokes one mode command and refuses task devices outside Main', async () => {
    const commands = host();
    const executor = new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' });
    await executor.execute({ ...schedule, action: { type: 'mode', mode: 'Night' } }, Date.now());
    expect(commands.handleOperatingModeChange).toHaveBeenCalledExactlyOnceWith('Night');
    commands.resolveSmartTaskHomeScope.mockReturnValue('sub_home');
    await expect(executor.execute(schedule, Date.now())).rejects.toThrow(ScheduleSkip);
    expect(commands.createNewDeferredObjective).not.toHaveBeenCalled();
  });
  it('words a refused create without its reason code', async () => {
    const commands = host();
    commands.createNewDeferredObjective.mockReturnValue({ ok: false, reason: 'device_not_planned' });
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
    expect(commands.createNewDeferredObjective).not.toHaveBeenCalled();
  });
  it('keeps a following-day deadline on a repeated-clock date instead of choosing the second fold today', async () => {
    vi.setSystemTime(Date.parse('2026-10-25T00:45:00Z'));
    const commands = host();
    const fold: Schedule = { ...schedule, at: '02:45', action: { type: 'task', task: {
      deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '02:30',
    } } };
    await new ScheduleActionExecutor(commands, { getTimezone: () => 'Europe/Oslo' })
      .execute(fold, Date.parse('2026-10-25T00:45:00Z'));
    expect(commands.createNewDeferredObjective).toHaveBeenCalledWith('charger', expect.objectContaining({
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
      expect(commands.createNewDeferredObjective).not.toHaveBeenCalled();
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
    expect(commands.createNewDeferredObjective).toHaveBeenCalledWith('charger', expect.objectContaining({
      deadlineAtMs: Date.parse('2026-10-28T20:01:00Z'),
    }));
  });

});
