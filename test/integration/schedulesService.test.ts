import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { ScheduleReceipt } from '../../lib/schedules/scheduleReceipts';
import { ScheduleService, type ScheduleRuntimePort } from '../../lib/schedules/scheduleService';
import { TimerRegistry } from '../../lib/utils/timerRegistry';

vi.mock('../../lib/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
const services: ScheduleService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });

const modeSchedule = (id = 'morning'): Schedule => ({
  id, name: 'Morning at home', enabled: true, at: '10:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] },
  condition: { type: 'any' }, action: { type: 'mode', mode: 'Home' },
});

const fixture = () => {
  let now = Date.parse('2026-10-28T08:59:00Z');
  let mode = 'Night';
  const values = new Map<string, unknown>();
  const receipts = new Map<string, ScheduleReceipt>();
  const execute = vi.fn(async (_schedule: Schedule, _at: number) => {});
  const port: ScheduleRuntimePort = {
    settings: {
      get: (key) => values.get(key), getKeys: () => [...values.keys()],
      set: (key, value) => { values.set(key, structuredClone(value)); }, unset: (key) => { values.delete(key); },
    },
    clock: { getTimezone: () => 'Europe/Oslo' }, timers: new TimerRegistry(),
    receipts: {
      read: (id) => receipts.get(id),
      write: (id, receipt) => { receipts.set(id, structuredClone(receipt)); },
      delete: (id) => { receipts.delete(id); },
    },
    getNowMs: () => now, listModes: () => ['Home', 'Night'], resolveModeName: (value) => value,
    currentMode: () => mode,
    listTaskDevices: () => [], execute,
  };
  const create = () => { const service = new ScheduleService(port); services.push(service); return service; };
  return { port, values, receipts, execute, create,
    setNow: (value: string) => { now = Date.parse(value); }, setMode: (value: string) => { mode = value; } };
};

describe('schedule owner', () => {
  it('reads a store with no settings at all as no schedules', () => {
    expect(fixture().create().read().entries).toEqual([]);
  });

  it('consumes before execution, fires once, and leaves a later manual mode alone', async () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.execute.mockImplementation(async (schedule) => { expect(f.receipts.has(schedule.id)).toBe(true); });
    const service = f.create(); service.start();
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.setMode('Night'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.port.currentMode()).toBe('Night');
    expect(service.read().entries[0]?.lastResult).toBe('Mode changed');
  });

  it('does not catch up at startup or after a long outage', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    f.setNow('2026-10-28T09:00:10Z'); const service = f.create(); service.start(); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
    f.setNow('2026-10-29T09:03:00Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('persists consumption through a restart and rejects a backwards-clock replay', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const first = f.create(); first.start();
    f.setNow('2026-10-28T09:00:00Z'); await first.tick(); await first.stop();
    const second = f.create(); second.start();
    f.setNow('2026-10-28T08:59:45Z'); await second.tick();
    f.setNow('2026-10-28T09:00:10Z'); await second.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves individual Off settings through group pause/resume', () => {
    const f = fixture(); const service = f.create();
    service.write({ type: 'save', schedule: modeSchedule() });
    service.write({ type: 'save', schedule: { ...modeSchedule('off'), at: '11:00', enabled: false } });
    service.write({ type: 'set_mode_schedules_enabled', enabled: false });
    let state = service.read();
    expect(state.entries.map((entry) => entry.state)).toEqual(['paused', 'off']);
    service.write({ type: 'set_mode_schedules_enabled', enabled: true });
    state = service.read();
    expect(state.entries.map((entry) => entry.state)).toEqual(['on', 'off']);
  });

  it('evaluates the mode condition at the occurrence and never retries a skipped occurrence', async () => {
    const f = fixture(); f.values.set('schedule.morning', { ...modeSchedule(),
      condition: { type: 'include', modes: ['Home'] } });
    const service = f.create(); service.start();
    expect(service.read().entries[0]?.state).toBe('on');
    f.setNow('2026-10-28T09:00:00Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
    f.setMode('Home'); f.setNow('2026-10-28T09:00:30Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
    expect(service.read().entries[0]?.lastResult).toContain('condition');
  });

  it('does not run newly saved or re-enabled past occurrences', async () => {
    const f = fixture(); const service = f.create(); service.start();
    f.setNow('2026-10-28T09:00:10Z');
    f.values.set('schedule.morning', modeSchedule()); service.read();
    f.setNow('2026-10-28T09:00:30Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('refuses conflicting writes and safely skips conflicting direct settings writes', async () => {
    const f = fixture(); const service = f.create();
    service.write({ type: 'save', schedule: modeSchedule() });
    expect(() => service.write({ type: 'save', schedule: modeSchedule('other') })).toThrow('same time');
    f.values.set('schedule.other', modeSchedule('other')); service.start();
    expect(service.read().entries.every((entry) => entry.state === 'invalid')).toBe(true);
    f.setNow('2026-10-28T09:00:00Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('retains config and refuses writes/execution during a flaky listed-key read', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const service = f.create(); service.start();
    f.port.settings.get = () => undefined;
    f.setNow('2026-10-28T09:00:00Z');
    await expect(service.tick()).rejects.toThrow();
    expect(() => service.write({ type: 'set_enabled', id: 'morning', enabled: false })).toThrow();
    expect(f.values.get('schedule.morning')).toEqual(modeSchedule());
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('consumes explicit deletion while leaving listed null as an unavailable read', () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const service = f.create(); service.read();
    f.values.set('schedule.morning', null);
    expect(() => service.read()).toThrow();
    f.values.set('schedule.morning', { deleted: true });
    expect(service.read().entries).toEqual([]);
    expect(f.values.has('schedule.morning')).toBe(false);
  });

  it('observes rapid direct Off/On settings writes without replaying a past trigger', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const service = f.create(); service.start();
    f.setNow('2026-10-28T09:00:10Z');
    f.values.set('schedule.morning', { ...modeSchedule(), enabled: false });
    service.onSettingsChanged('schedule.morning');
    f.values.set('schedule.morning', modeSchedule());
    service.onSettingsChanged('schedule.morning');
    f.setNow('2026-10-28T09:00:30Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
    expect(service.read().entries[0]?.state).toBe('on');
  });

  it('keeps mode schedules independent of an unavailable task-device read', async () => {
    const f = fixture(); f.port.listTaskDevices = () => { throw new Error('Devices unavailable'); };
    const service = f.create(); service.write({ type: 'save', schedule: modeSchedule() }); service.start();
    expect(service.read().entries[0]?.state).toBe('on');
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('allows disabling an expired or unavailable schedule', () => {
    const f = fixture();
    f.values.set('schedule.morning', { ...modeSchedule(), action: { type: 'mode', mode: 'Deleted mode' },
      repeat: { type: 'once', date: '2026-10-27' } });
    const service = f.create();
    service.write({ type: 'set_enabled', id: 'morning', enabled: false });
    expect(service.read().entries[0]?.state).toBe('off');
  });

  it('drains an in-flight action at stop without starting another action', async () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.values.set('schedule.other', { ...modeSchedule('other'), at: '10:01' });
    let finish = () => {};
    f.execute.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const service = f.create(); service.start();
    f.setNow('2026-10-28T09:01:01Z');
    const tick = service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopped = service.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish(); await tick; await stopped;
    expect(drained).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.receipts.get('morning')?.lastResult).toBe('Mode changed');
  });

  it('keeps config lookup and control writes independent of unrelated task eligibility', () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.values.set('schedule.water', { ...modeSchedule('water'), action: { type: 'task', task: {
      deviceId: 'water-heater', kind: 'temperature', target: 65, readyByLocalTime: '07:00',
    } } });
    f.port.listTaskDevices = vi.fn(() => { throw new Error('Unavailable devices'); });
    const service = f.create();
    expect(service.lookup('morning').enabled).toBe(true);
    expect(service.definitions()).toHaveLength(2);
    expect(() => service.write({ type: 'set_enabled', id: 'morning', enabled: false })).not.toThrow();
    expect(() => service.write({ type: 'set_enabled', id: 'morning', enabled: true })).not.toThrow();
    expect(() => service.write({ type: 'set_mode_schedules_enabled', enabled: false })).not.toThrow();
    expect(() => service.write({ type: 'set_device_schedules_enabled', deviceId: 'water-heater', enabled: false }))
      .not.toThrow();
    expect(service.lookup('morning').enabled).toBe(true);
    expect(f.values.get('schedule_modes_enabled')).toBe(false);
    expect(f.values.get('schedule_task_enabled.water-heater')).toBe(false);
    expect(f.port.listTaskDevices).not.toHaveBeenCalled();
  });

  it('projects one catalog generation and isolates unavailable task details to task entries', () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.values.set('schedule.night', { ...modeSchedule('night'), at: '22:00' });
    for (const id of ['water', 'office']) f.values.set(`schedule.${id}`, {
      ...modeSchedule(id), action: { type: 'task', task: {
        deviceId: id, kind: 'temperature', target: 21, readyByLocalTime: '07:00',
      } },
    });
    f.port.listModes = vi.fn(() => ['Home', 'Night']);
    f.port.listTaskDevices = vi.fn(() => { throw new Error('Unavailable devices'); });
    const entries = f.create().read().entries;
    expect(f.port.listModes).toHaveBeenCalledTimes(1);
    expect(f.port.listTaskDevices).toHaveBeenCalledTimes(1);
    expect(entries.slice(0, 2).map((entry) => entry.state)).toEqual(['on', 'on']);
    expect(entries.slice(2).map((entry) => entry.state)).toEqual(['invalid', 'invalid']);
    expect(entries[2]?.reason).toContain('temporarily unavailable');
  });

  it('does not project device eligibility for disabled task definitions', () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.values.set('schedule.water', { ...modeSchedule('water'), enabled: false, action: { type: 'task', task: {
      deviceId: 'water', kind: 'temperature', target: 65, readyByLocalTime: '07:00',
    } } });
    f.port.listTaskDevices = vi.fn(() => { throw new Error('Unavailable devices'); });
    expect(f.create().read().entries.map((entry) => entry.state)).toEqual(['on', 'off']);
    expect(f.port.listTaskDevices).not.toHaveBeenCalled();
  });

  it('quarantines one unreadable receipt without hiding or starving a later healthy schedule', async () => {
    const f = fixture();
    f.values.set('schedule.bad', modeSchedule('bad'));
    f.values.set('schedule.healthy', { ...modeSchedule('healthy'), at: '10:01' });
    f.port.receipts.read = (id) => {
      if (id === 'bad') throw new Error('Invalid receipt');
      return f.receipts.get(id);
    };
    const service = f.create(); service.start();
    expect(service.read().entries.map((entry) => entry.state)).toEqual(['invalid', 'on']);
    f.setNow('2026-10-28T09:01:01Z');
    await expect(service.tick()).resolves.toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0].id).toBe('healthy');
    expect(f.receipts.get('healthy')?.lastResult).toBe('Mode changed');
  });

  it('runs a later mode schedule when an earlier task cannot read its device catalog', async () => {
    const f = fixture();
    f.values.set('schedule.task', { ...modeSchedule('task'), action: { type: 'task', task: {
      deviceId: 'water', kind: 'temperature', target: 65, readyByLocalTime: '07:00',
    } } });
    f.values.set('schedule.mode', { ...modeSchedule('mode'), at: '10:01' });
    f.port.listTaskDevices = () => { throw new Error('Unavailable devices'); };
    const service = f.create(); service.start();
    f.setNow('2026-10-28T09:01:01Z');
    await expect(service.tick()).resolves.toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0].id).toBe('mode');
  });

  it('finalizes a successful action despite an unrelated config read failing afterward', async () => {
    const f = fixture();
    f.values.set('schedule.morning', modeSchedule());
    f.values.set('schedule.later', { ...modeSchedule('later'), at: '11:00' });
    const service = f.create(); service.start();
    f.execute.mockImplementation(async () => {
      f.port.settings.get = (key) => {
        if (key === 'schedule.later') throw new Error('Unavailable unrelated config');
        return f.values.get(key);
      };
    });
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.receipts.get('morning')?.lastResult).toBe('Mode changed');
    f.port.settings.get = (key) => f.values.get(key);
    f.setNow('2026-10-28T09:00:30Z'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the consumption receipt when final config verification is unavailable', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const service = f.create(); service.start();
    f.execute.mockImplementation(async () => { f.port.settings.get = () => { throw new Error('Unavailable'); }; });
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.receipts.get('morning')?.lastResult).toBe('Trigger recorded.');
    f.port.settings.get = (key) => f.values.get(key);
    f.setNow('2026-10-28T09:00:30Z'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a receipt deleted while its action was in flight', async () => {
    const f = fixture(); f.values.set('schedule.morning', modeSchedule());
    const service = f.create(); service.start();
    f.execute.mockImplementation(async () => {
      f.values.delete('schedule.morning');
      f.receipts.delete('morning');
    });
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.receipts.has('morning')).toBe(false);
    expect(service.definitions()).toEqual([]);
  });


  it.each([
    { type: 'include' as const, current: 'Sleep', runs: true },
    { type: 'exclude' as const, current: 'Home', runs: true },
    { type: 'exclude' as const, current: 'Sleep', runs: false },
  ])('resolves renamed modes for $type conditions without rewriting saved intent', async (example) => {
    const f = fixture();
    const definition: Schedule = { ...modeSchedule(), action: { type: 'mode', mode: 'Night' },
      condition: { type: example.type, modes: ['Night'] } };
    f.values.set('schedule.morning', definition);
    f.port.listModes = () => ['Home', 'Sleep'];
    f.port.resolveModeName = (value) => value === 'Night' ? 'Sleep' : value;
    f.setMode(example.current);
    const service = f.create(); service.start();
    const entry = service.read().entries[0];
    expect(entry?.state).toBe('on');
    expect(entry?.schedule.action).toEqual({ type: 'mode', mode: 'Night' });
    expect(entry?.schedule.condition).toEqual({ type: example.type, modes: ['Night'] });
    expect(entry?.modeReferences).toEqual([{ stored: 'Night', resolved: 'Sleep' }]);
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.execute).toHaveBeenCalledTimes(example.runs ? 1 : 0);
    if (example.runs) expect(f.execute.mock.calls[0]?.[0].action).toEqual({ type: 'mode', mode: 'Night' });
    expect(f.values.get('schedule.morning')).toEqual(definition);
  });

  it('does not resolve an aliased action twice when configured names were swapped', async () => {
    const f = fixture();
    f.values.set('schedule.morning', { ...modeSchedule(), action: { type: 'mode', mode: 'Night' } });
    f.port.listModes = () => ['Home', 'Work'];
    const aliases: Record<string, string> = { Night: 'Home', Home: 'Work' };
    f.port.resolveModeName = (value) => aliases[value] || value;
    const service = f.create(); service.start();
    expect(service.read().entries[0]?.schedule.action).toEqual({ type: 'mode', mode: 'Night' });
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    // The existing mode-action owner resolves the saved argument once; passing Home here would select Work.
    expect(f.execute.mock.calls[0]?.[0].action).toEqual({ type: 'mode', mode: 'Night' });
  });

  it('keeps a truly deleted mode invalid rather than substituting a current mode', async () => {
    const f = fixture(); f.port.listModes = () => ['Home'];
    f.values.set('schedule.morning', { ...modeSchedule(), action: { type: 'mode', mode: 'Deleted' } });
    const service = f.create(); service.start();
    expect(service.read().entries[0]).toMatchObject({ state: 'invalid', modeReferences: [] });
    f.setNow('2026-10-28T09:00:10Z'); await service.tick();
    expect(f.execute).not.toHaveBeenCalled();
  });

});
