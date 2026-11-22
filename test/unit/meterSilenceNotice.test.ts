import { MeterSilenceMonitor } from '../../lib/power/meterSilence';
import { MeterSilenceNotice } from '../../lib/power/meterSilenceNotice';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';

const T0 = Date.UTC(2026, 10, 22, 0, 36, 0);
const MINUTE = 60 * 1000;

const build = (options: { source?: 'homey_energy' | 'flow' | null; tracker?: () => PowerTrackerState } = {}) => {
  const state = { lastSampleAtMs: T0 as number | undefined, nowMs: T0 };
  const monitor = new MeterSilenceMonitor({
    homeId: MAIN_HOME_ID,
    getPowerTracker: options.tracker ?? (() => ({ lastTimestamp: state.lastSampleAtMs })),
    nowMs: () => state.nowMs,
    structuredLog: () => ({ info: vi.fn(), warn: vi.fn() }),
  });
  const createNotification = vi.fn(async (_options: { excerpt: string }) => undefined);
  const notice = new MeterSilenceNotice({
    meterSilence: monitor,
    notifications: { createNotification },
    readPowerSource: () => (options.source === undefined ? 'homey_energy' : options.source),
    nowMs: () => state.nowMs,
    logger: () => ({ info: vi.fn(), warn: vi.fn() }),
  });
  const runPass = () => {
    const owed = monitor.shedPassOwedFor();
    if (owed === null) throw new Error('no pass owed');
    monitor.noteShedPassCompleted(owed);
  };
  const excerpts = () => createNotification.mock.calls.map(([call]) => call.excerpt);
  return { state, monitor, notice, runPass, createNotification, excerpts };
};

describe('MeterSilenceNotice', () => {
  it('says nothing while the meter is silent but the fail-closed pass has not run', async () => {
    const { state, notice, createNotification } = build();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + MINUTE;
    await notice.check();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('announces the outage once when the pass has limited the devices, and its end once', async () => {
    const { state, notice, runPass, excerpts } = build();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    runPass();
    await notice.check();
    await notice.check();
    expect(excerpts()).toEqual([
      'PELS has had no new power reading for 10 min and has limited your managed devices to stay within '
        + 'your limits. They resume when a new reading arrives. Check that the selected whole-home meter is '
        + 'available in Homey Energy and its reading is changing.',
    ]);

    state.lastSampleAtMs = state.nowMs + MINUTE;
    state.nowMs += MINUTE;
    await notice.check();
    await notice.check();
    expect(excerpts()).toHaveLength(2);
    expect(excerpts()[1]).toBe('PELS has new power readings again and is resuming your managed devices.');
  });

  it('names the Flow remedy for a Flow source and no remedy when the source cannot be read', async () => {
    const flow = build({ source: 'flow' });
    flow.state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    flow.runPass();
    await flow.notice.check();
    expect(flow.excerpts()[0]).toMatch(/Check the Flow that runs Report power usage/);

    const unknown = build({ source: null });
    unknown.state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    unknown.runPass();
    await unknown.notice.check();
    expect(unknown.excerpts()[0]).toMatch(/They resume when a new reading arrives\.$/);
  });

  it('announces a later outage again', async () => {
    const { state, notice, runPass, excerpts } = build();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    runPass();
    await notice.check();
    state.lastSampleAtMs = state.nowMs;
    await notice.check();
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    runPass();
    await notice.check();
    expect(excerpts()).toHaveLength(3);
    expect(excerpts()[2]).toMatch(/^PELS has had no new power reading/);
  });

  it('retries a notice Homey refused', async () => {
    const { state, notice, runPass, createNotification } = build();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    runPass();
    createNotification.mockRejectedValueOnce(new Error('timeline unavailable'));
    await notice.check();
    await notice.check();
    expect(createNotification).toHaveBeenCalledTimes(2);
  });

  it('says why PELS stopped trusting a reading that froze under moving load', async () => {
    const frozenSinceMs = T0 - 5 * MINUTE;
    const nowMs = T0 + 2 * POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    const tracker = (): PowerTrackerState => ({
      lastTimestamp: nowMs - 1000,
      lastPowerW: 1362,
      heldReading: {
        powerW: 1362,
        sinceMs: frozenSinceMs,
        atMs: nowMs - 1000,
        baseline: { totalW: 500, loadKey: 1 },
        contradictedAtMs: T0,
      },
    } as PowerTrackerState);
    const { state, notice, runPass, excerpts } = build({ tracker });
    state.nowMs = nowMs;
    runPass();
    await notice.check();
    expect(excerpts()[0]).toMatch(
      /^Your power reading has not changed for 25 min while your devices' own readings did, so PELS no longer trusts it/,
    );
  });
});
