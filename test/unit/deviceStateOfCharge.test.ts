import { resolveStateOfChargeSnapshot } from '../../lib/device/transport/stateOfCharge';

describe('resolveStateOfChargeSnapshot', () => {
  it('prefers native SoC capabilities over flow-backed battery reports', () => {
    const snapshot = resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: Date.parse('2026-03-20T06:00:02.000Z'),
      capabilityObj: {
        evcharger_charging_state: {
          value: 'plugged_in_charging',
          lastUpdated: '2026-03-20T06:00:00.000Z',
        },
        measure_soc_level: {
          value: 55,
          lastUpdated: '2026-03-20T06:00:01.000Z',
        },
      },
      reportedCapabilities: {
        measure_battery: {
          value: 42,
          reportedAt: Date.parse('2026-03-20T05:58:00.000Z'),
          source: 'flow',
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      percent: 55,
      capabilityId: 'measure_soc_level',
      status: 'fresh',
    }));
  });

  const SOC_AT = Date.parse('2026-03-20T06:00:00.000Z');

  const resolve = (params: {
    chargingState: string;
    chargingStateAt: number;
    nowMs: number;
    charging?: boolean;
    retainedSession?: { sessionStartedAtMs?: number; invalidatedAtMs?: number };
  }) => resolveStateOfChargeSnapshot({
    deviceClassKey: 'evcharger',
    nowMs: params.nowMs,
    capabilityObj: {
      evcharger_charging_state: {
        value: params.chargingState,
        lastUpdated: params.chargingStateAt,
      },
      ...(params.charging === undefined
        ? {}
        : { evcharger_charging: { value: params.charging } }),
      measure_battery: { value: 34, lastUpdated: SOC_AT },
    },
    reportedCapabilities: {},
    retainedSession: params.retainedSession,
  });

  // Prod 2026-07-26: PELS paused an Easee, the charger dropped
  // `plugged_in_charging` → `plugged_in` two minutes after the last SoC report,
  // and the re-stamped charging-state timestamp was read as a new session —
  // marking a two-minute-old reading stale for the rest of the night.
  it('keeps the reading fresh when a connected sub-state change post-dates it', () => {
    expect(resolve({
      chargingState: 'plugged_in',
      chargingStateAt: SOC_AT + 2 * 60_000,
      nowMs: SOC_AT + 3 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'fresh' }));
  });

  // The charger republishes only on a level change, which cannot happen while
  // it is idle; ageing the reading out would strand the smart task that paused it.
  it('does not age out a reading while the charger is idle', () => {
    expect(resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT,
      charging: false,
      nowMs: SOC_AT + 6 * 60 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'fresh' }));
  });

  // An Easee can leave `evcharger_charging` lingering `true` across a pause. The
  // state enum is authoritative (`resolveEvCurrentOn`), so that stale boolean must
  // not age out the reading of a charger the state string says is paused.
  it('does not age out a paused charger whose charging boolean still lingers true', () => {
    expect(resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 41 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'fresh' }));
  });

  it('ages out a reading that goes unrefreshed while the charger is charging', () => {
    expect(resolve({
      chargingState: 'plugged_in_charging',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 41 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'stale' }));
  });

  it('ages out on the charging boolean alone when the plug state stays generic', () => {
    expect(resolve({
      chargingState: 'plugged_in',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 41 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'stale' }));
  });

  it('marks the reading stale once the car is unplugged', () => {
    expect(resolve({
      chargingState: 'plugged_out',
      chargingStateAt: SOC_AT + 60_000,
      nowMs: SOC_AT + 2 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, status: 'stale' }));
  });

  // A refresh sees only the CURRENT plug state, so the retained session is the
  // only evidence that the connected charger was replugged — possibly with a
  // different car — since the reading was taken.
  it('marks the reading stale after a replug reported through the retained session', () => {
    const unplugged = resolve({
      chargingState: 'plugged_out',
      chargingStateAt: SOC_AT + 60_000,
      nowMs: SOC_AT + 2 * 60_000,
    });

    expect(resolve({
      chargingState: 'plugged_in',
      chargingStateAt: SOC_AT + 3 * 60_000,
      nowMs: SOC_AT + 4 * 60_000,
      retainedSession: unplugged,
    })).toEqual(expect.objectContaining({
      percent: 34,
      status: 'stale',
      sessionStartedAtMs: SOC_AT + 3 * 60_000,
    }));
  });

  // A reconnect anchors only on REAL evidence. Substituting the refresh time was
  // tried and reverted: a refresh can carry a cached connected state older than a
  // newer realtime plug-out, and a fabricated future `sessionStartedAtMs` cannot
  // be undone by reapplying that plug-out. The cost — the reading stays stale
  // until a timestamped observation arrives — is tracked as a P1 in TODO.md.
  it('does not anchor a reconnect from a connected state carrying no timestamp', () => {
    const unplugged = resolve({
      chargingState: 'plugged_out',
      chargingStateAt: SOC_AT + 60_000,
      nowMs: SOC_AT + 2 * 60_000,
    });

    expect(resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: SOC_AT + 4 * 60_000,
      capabilityObj: {
        evcharger_charging_state: { value: 'plugged_in' },
        measure_battery: { value: 34, lastUpdated: SOC_AT },
      },
      reportedCapabilities: {},
      retainedSession: unplugged,
    })?.sessionStartedAtMs).toBeUndefined();
  });
});
