import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PowerHistoryRecoveryOwner, type PowerHistoryRecoveryPorts } from '../../lib/power/powerHistoryRecoveryOwner';
import type { HomeTrackerPersistence } from '../../lib/power/homeTrackerPersistence';
import { POWER_HISTORY_RECOVERY_REQUEST } from '../../packages/shared-domain/src/settings/powerHistoryRecovery';
import { buildHourlyInsightsHistory } from '../helpers/hourlyInsightsHistory';
import { partialDouble } from '../helpers/partialDouble';

const build = () => {
  const fixture = buildHourlyInsightsHistory();
  let request: unknown = { id: 'old-command' };
  const events = new EventEmitter();
  const append = vi.fn<HomeTrackerPersistence['appendMissingHours']>(() => ({ state: 'saved', addedHours: 135 }));
  const tracker = partialDouble<HomeTrackerPersistence>({
    getHistoryRevision: () => 0,
    getHistoryForRecovery: () => fixture.tracker,
    appendMissingHours: append,
  });
  const ports: PowerHistoryRecoveryPorts = {
    readRequest: () => request,
    clearRequest: vi.fn(() => { request = null; }),
    readPowerSource: () => ({ state: 'resolved', value: 'homey_energy' }),
    readMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'meter-a' }),
    fetchInsights: vi.fn(async (path) => {
      if (path === 'manager/insights/log') return fixture.metadata;
      return path.includes('meter_power.exported') ? fixture.exported : fixture.power;
    }),
    getTracker: () => tracker,
    nowMs: () => fixture.nowMs,
    readTimeZone: () => 'Europe/Oslo',
    isTornDown: () => false,
    onUpdated: vi.fn(),
  };
  const owner = new PowerHistoryRecoveryOwner(ports);
  owner.attach(events);
  const ids = new Map<string, string>();
  const send = (alias: string) => {
    const id = ids.get(alias) ?? randomUUID();
    ids.set(alias, id);
    request = { id };
    events.emit('set', POWER_HISTORY_RECOVERY_REQUEST);
    return id;
  };
  const finish = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    return owner.read();
  };
  return { fixture, owner, ports, tracker, append, send, finish, events };
};

describe('PowerHistoryRecoveryOwner', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('clears old commands and handles only a fresh explicit request', async () => {
    const { owner, ports, send, finish, append } = build();
    expect(owner.read()).toEqual({ state: 'idle' });
    expect(ports.fetchInsights).not.toHaveBeenCalled();
    const requestId = send('recovery-1');
    expect(owner.read()).toEqual({ state: 'running', requestId });
    expect(await finish()).toEqual({ state: 'done', requestId, addedHours: 135 });
    expect(append).toHaveBeenCalledTimes(1);
    expect(ports.onUpdated).toHaveBeenCalledOnce();
    send('recovery-1');
    await finish();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('rejects source/meter changes, reset, and teardown while fetching', async () => {
    for (const change of ['meter', 'source', 'reset', 'teardown', 'detach'] as const) {
      const { owner, ports, tracker, send, finish, append, events } = build();
      send(`recovery-${change}`);
      if (change === 'meter') ports.readMainMeterSelection = () => ({ state: 'resolved', meterDeviceId: 'meter-b' });
      if (change === 'source') ports.readPowerSource = () => ({ state: 'resolved', value: 'flow' });
      if (change === 'reset') tracker.getHistoryRevision = () => 1;
      if (change === 'teardown') ports.isTornDown = () => true;
      if (change === 'detach') owner.detach(events);
      expect((await finish()).state).toBe('failed');
      expect(append).not.toHaveBeenCalled();
    }
  });

  it('surfaces persistence failure and preserves success after a refresh failure', async () => {
    const failed = build();
    failed.append.mockReturnValue({ state: 'failed' });
    failed.send('failed');
    expect((await failed.finish()).state).toBe('failed');
    expect(failed.ports.onUpdated).not.toHaveBeenCalled();
    const saved = build();
    saved.ports.onUpdated = () => { throw new Error('refresh failed'); };
    const requestId = saved.send('saved');
    expect(await saved.finish()).toEqual({ state: 'done', requestId, addedHours: 135 });
  });

  it('times out an unresponsive fetch, permits retry and ignores a late response', async () => {
    vi.useFakeTimers();
    const { fixture, ports, owner, append, send, finish } = build();
    let completeFetch: (response: unknown) => void = () => {};
    vi.mocked(ports.fetchInsights).mockImplementationOnce(() => new Promise((resolve) => { completeFetch = resolve; }));
    const requestId = send('timeout');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(owner.read()).toEqual({ state: 'failed', requestId,
      message: 'Insights history took too long to respond. Try recovery again.' });
    expect(append).not.toHaveBeenCalled();
    completeFetch(fixture.metadata);
    await finish();
    expect(append).not.toHaveBeenCalled();
    const retryId = send('retry');
    expect(await finish()).toEqual({ state: 'done', requestId: retryId, addedHours: 135 });
    expect(append).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
