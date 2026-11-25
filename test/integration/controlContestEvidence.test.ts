import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlContestEvidence } from '../../lib/diagnostics/controlContestEvidence';
import { ADVANCED_FLOW_API_PATH, FLOW_API_PATH } from '../../lib/flowApi/readUserFlows';
import type { ControlContestOccurrence } from '../../lib/ports/controlContest';
import type { DeviceJournal } from '../../lib/ports/deviceJournal';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import { ShutdownLatch } from '../../lib/utils/shutdownLatch';

const NOW = Date.UTC(2026, 9, 25, 10, 0);
const contest: ControlContestOccurrence = {
  deviceId: 'heater', setting: 'on_off', firstAtMs: NOW - 50_000, lastAtMs: NOW,
};

const card = (deviceId: string, action: string) => ({
  id: `homey:device:${deviceId}:${action}`,
  args: { sensitiveToken: 'unrelated-do-not-keep' },
});

const timelinePath = (deviceId: string, capability: string): string => {
  const owner = `homey:device:${deviceId}`;
  const resolution = capability === 'onoff' ? 'last24Hours' : 'lastHour';
  return `manager/insights/log/${owner}/${owner}:${capability}/entry?resolution=${resolution}`;
};

describe('control contest diagnostics', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('journals attribution and enabled Flow candidates for the contested setting and omits personal fields', async () => {
    vi.useFakeTimers({ now: NOW });
    const record = vi.fn<DeviceJournal['record']>();
    const get = vi.fn(async (path: string) => {
      if (path === FLOW_API_PATH) {
        return {
          morning: { name: 'Morning', actions: [card('heater', 'on'), card('heater', 'off')] },
          disabled: { name: 'Disabled', enabled: false, actions: [card('heater', 'off')] },
          otherDevice: { name: 'Other device', actions: [card('lamp', 'on')] },
          otherCapability: { name: 'Other capability', actions: [card('heater', 'target_temperature_set')] },
        };
      }
      if (path === ADVANCED_FLOW_API_PATH) {
        return {
          evening: { name: 'Evening', cards: {
            action: { ...card('heater', 'toggle'), type: 'action' },
            trigger: { ...card('heater', 'on'), type: 'trigger' },
          } },
        };
      }
      if (path !== timelinePath('heater', 'onoff')) throw new Error('unexpected path');
      return { values: [
        {
          t: new Date(NOW - 10_000).toISOString(), v: true,
          originUri: 'homey:flow:evening', originName: 'Evening', originUserName: 'Private name',
          originClientId: 'private-client', originUserId: 'private-user',
        },
        { t: new Date(NOW - 20_000).toISOString(), v: false, originUri: 'homey:user:anonymous', originName: 'Private' },
        { t: 'invalid', v: true },
        { t: new Date(NOW - 30_000).toISOString(), v: 1 },
        { t: new Date(NOW - 300_000).toISOString(), v: true },
        { t: new Date(NOW + 1_000).toISOString(), v: true },
      ] };
    });
    const evidence = new ControlContestEvidence(get, { record }, new ShutdownLatch());

    const reportedContest = { ...contest, component: 'executor', event: 'device_control_contested', count: 4 };
    evidence.collect(reportedContest);
    expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);

    expect(record).toHaveBeenCalledExactlyOnceWith(['heater'], {
      component: 'diagnostics', event: 'device_control_contest_evidence', ...contest,
      timeline: { state: 'available', leftOut: 0, entries: [
        { atMs: NOW - 20_000, value: false },
        { atMs: NOW - 10_000, value: true, originUri: 'homey:flow:evening', originName: 'Evening' },
      ] },
      candidateFlows: { state: 'available', leftOut: 0, flows: [
        { flowId: 'morning', flowName: 'Morning' }, { flowId: 'evening', flowName: 'Evening' },
      ] },
    });
  });

  it('keeps candidate setpoint Flows when the device has no Insights log', async () => {
    vi.useFakeTimers({ now: NOW });
    const record = vi.fn<DeviceJournal['record']>();
    const get = vi.fn(async (path: string) => {
      if (path === FLOW_API_PATH) return { heat: { name: 'Heat', actions: [card('heater', 'target_temperature_set')] } };
      if (path === ADVANCED_FLOW_API_PATH) return {};
      if (path === timelinePath('heater', 'target_temperature')) throw new HomeyHttpStatusError(404, '');
      throw new Error('unexpected path');
    });
    const evidence = new ControlContestEvidence(get, { record }, new ShutdownLatch());

    evidence.collect({ ...contest, setting: 'temperature' });
    await vi.advanceTimersByTimeAsync(0);

    expect(record).toHaveBeenCalledExactlyOnceWith(['heater'], expect.objectContaining({
      timeline: { state: 'unavailable', reason: 'missing_log' },
      candidateFlows: { state: 'available', leftOut: 0, flows: [{ flowId: 'heat', flowName: 'Heat' }] },
    }));
  });

  it('shares Flow reads across two devices and keeps bounded timeline data when the Flow reads time out', async () => {
    vi.useFakeTimers({ now: NOW });
    const record = vi.fn<DeviceJournal['record']>();
    const get = vi.fn((path: string) => {
      if (path === FLOW_API_PATH || path === ADVANCED_FLOW_API_PATH) return new Promise<unknown>(() => undefined);
      const values = Array.from({ length: 18 }, (_, index) => ({
        t: new Date(NOW - 18_000 + index * 1_000).toISOString(), v: true,
      }));
      return Promise.resolve({ values });
    });
    const evidence = new ControlContestEvidence(get, { record }, new ShutdownLatch());

    evidence.collect(contest);
    evidence.collect(contest);
    evidence.collect({ ...contest, deviceId: 'other-heater' });
    evidence.collect({ ...contest, deviceId: 'third-heater' });
    evidence.collect({ ...contest, deviceId: 'stepped', setting: 'level' });
    await vi.advanceTimersByTimeAsync(0);

    expect(get.mock.calls.flat()).toEqual([
      timelinePath('heater', 'onoff'), FLOW_API_PATH, ADVANCED_FLOW_API_PATH, timelinePath('other-heater', 'onoff'),
    ]);
    expect(record).toHaveBeenCalledTimes(2);
    for (const deviceId of ['heater', 'third-heater']) {
      expect(record).toHaveBeenCalledWith([deviceId], expect.objectContaining({ state: 'skipped', reason: 'busy' }));
    }

    await vi.advanceTimersByTimeAsync(10_000);

    expect(record).toHaveBeenCalledTimes(4);
    for (const deviceId of ['heater', 'other-heater']) {
      expect(record).toHaveBeenCalledWith([deviceId], expect.objectContaining({
        timeline: {
          state: 'available', leftOut: 2,
          entries: Array.from({ length: 16 }, (_, index) => ({ atMs: NOW - 16_000 + index * 1_000, value: true })),
        },
        candidateFlows: { state: 'unavailable', reason: 'timeout' },
      }));
    }

    // A hung request cannot prevent later contests from doing their own Flow lookup.
    get.mockResolvedValue({});
    evidence.collect({ ...contest, deviceId: 'later-heater' });
    await vi.advanceTimersByTimeAsync(0);
    expect(get.mock.calls.flat().filter((path) => path === FLOW_API_PATH)).toHaveLength(2);
    expect(record).toHaveBeenCalledWith(['later-heater'], expect.objectContaining({
      candidateFlows: { state: 'available', flows: [], leftOut: 0 },
    }));
  });
});
