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
  const values = new Map<string, unknown>([['sentinel', true]]);
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
    getNowMs: () => now, listModes: () => ['Home', 'Night'], currentMode: () => mode,
    listTaskDevices: () => [], execute,
  };
  const create = () => { const service = new ScheduleService(port); services.push(service); return service; };
  return { port, values, receipts, execute, create,
    setNow: (value: string) => { now = Date.parse(value); }, setMode: (value: string) => { mode = value; } };
};

describe('schedule owner', () => {
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
    let state = service.write({ type: 'set_mode_schedules_enabled', enabled: false });
    expect(state.entries.map((entry) => entry.state)).toEqual(['paused', 'off']);
    state = service.write({ type: 'set_mode_schedules_enabled', enabled: true });
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
    expect(service.write({ type: 'set_enabled', id: 'morning', enabled: false }).entries[0]?.state).toBe('off');
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

});
