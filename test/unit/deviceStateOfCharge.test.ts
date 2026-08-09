import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  resolveStateOfChargeSnapshot,
  updateStateOfChargeFromCarObservation,
} from '../../lib/device/transport/stateOfCharge';
import { clearCarStateOfCharge } from '../../lib/device/transport/carStateOfChargeWrite';

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
      level: { kind: 'known', percent: 55 },
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
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // The charger republishes only on a level change, which cannot happen while
  // it is idle; ageing the reading out would strand the smart task that paused it.
  it('does not age out a reading while the charger is idle', () => {
    expect(resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT,
      charging: false,
      nowMs: SOC_AT + 6 * 60 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // An Easee can leave `evcharger_charging` lingering `true` across a pause, and
  // a charger paused for hours is the ordinary overnight case.
  it('does not age out a paused charger whose charging boolean still lingers true', () => {
    expect(resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 41 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // The gate this replaced measured age in TOTAL wall-clock, so the moment PELS
  // resumed a charger it had paused for more than 40 minutes, the reading was
  // stale — and `measure_battery` is change-only, so the car could not republish
  // to clear it. The smart task then paused the charger again, which is the
  // oscillation the pause fix existed to remove, reached by another route.
  it('keeps the reading when a long pause ends and charging resumes', () => {
    const paused = resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT,
      charging: false,
      nowMs: SOC_AT + 3 * 60 * 60_000,
    });

    expect(resolve({
      chargingState: 'plugged_in_charging',
      chargingStateAt: SOC_AT + 3 * 60 * 60_000,
      charging: true,
      nowMs: SOC_AT + 3 * 60 * 60_000 + 1_000,
      retainedSession: paused,
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // The deliberate behaviour change: a level belongs to its session, not to a
  // clock. A charger that keeps charging without republishing leaves PELS holding
  // the level it last reported — the old gate turned that into a qualifier every
  // consumer then reinterpreted, and it also fired for chargers that were simply
  // idle. There is no ageing here.
  it('keeps a reading that goes unrefreshed while the charger is charging', () => {
    expect(resolve({
      chargingState: 'plugged_in_charging',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 6 * 60 * 60_000,
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // The mirror of the case above, and the second direction the old gate got
  // wrong: once a reading HAD aged out mid-charge, the next idle observation
  // reached an unconditional `return 'fresh'` and resurrected it. Nothing can
  // resurrect a reading now, because nothing retires one but its session.
  it('does not flip a long-charging reading when the charger falls idle', () => {
    const charging = resolve({
      chargingState: 'plugged_in_charging',
      chargingStateAt: SOC_AT,
      charging: true,
      nowMs: SOC_AT + 6 * 60 * 60_000,
    });

    expect(resolve({
      chargingState: 'plugged_in_paused',
      chargingStateAt: SOC_AT + 6 * 60 * 60_000,
      charging: false,
      nowMs: SOC_AT + 6 * 60 * 60_000 + 1_000,
      retainedSession: charging,
    })).toEqual(expect.objectContaining({ percent: 34, level: { kind: 'known', percent: 34 } }));
  });

  // V2G: a discharging car is attached, so a reconnect observed in that state
  // anchors its session like any other connected one.
  it('anchors a reconnect observed while the car is discharging', () => {
    const unplugged = resolve({
      chargingState: 'plugged_out',
      chargingStateAt: SOC_AT + 60_000,
      nowMs: SOC_AT + 2 * 60_000,
    });

    expect(resolve({
      chargingState: 'plugged_in_discharging',
      chargingStateAt: SOC_AT + 3 * 60_000,
      nowMs: SOC_AT + 4 * 60_000,
      retainedSession: unplugged,
    })?.sessionStartedAtMs).toBe(SOC_AT + 3 * 60_000);
  });

  it('reports no level once the car is unplugged', () => {
    expect(resolve({
      chargingState: 'plugged_out',
      chargingStateAt: SOC_AT + 60_000,
      nowMs: SOC_AT + 2 * 60_000,
    })?.level).toEqual({ kind: 'unavailable', reasonCode: 'not_connected' });
  });

  // A refresh sees only the CURRENT plug state, so the retained session is the
  // only evidence that the connected charger was replugged — possibly with a
  // different car — since the reading was taken.
  it('reports no level after a replug reported through the retained session', () => {
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
      // A car is attached again, but this reading predates it — possibly a
      // different car.
      level: { kind: 'unavailable', reasonCode: 'not_reported' },
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

describe('car-sourced state of charge', () => {
  const chargerCaps = {
    measure_battery: { value: 55, lastUpdated: 1_000 },
    evcharger_charging_state: { value: 'plugged_in_charging', lastUpdated: 500 },
    evcharger_charging: { value: true, lastUpdated: 500 },
  };

  it('reports nothing from the charger itself once a car is ticked for it', () => {
    // The opt-in makes the car the only source: a native reading and a
    // flow-reported one are both ignored, so the level cannot flip between two
    // sources mid-session.
    expect(resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: 2_000,
      capabilityObj: chargerCaps,
      reportedCapabilities: {},
      eligibleCarIds: ['car-1'],
    })).toBeUndefined();
  });

  it('still reads the charger when no car is ticked', () => {
    expect(resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: 2_000,
      capabilityObj: chargerCaps,
      reportedCapabilities: {},
    })).toMatchObject({ percent: 55 });
  });

  it('carries a car-sourced level across a refresh, with its provenance', () => {
    const resolved = resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: 2_000,
      capabilityObj: chargerCaps,
      reportedCapabilities: {},
      eligibleCarIds: ['car-1'],
      retainedStateOfCharge: stateOfChargeFixture({ percent: 63, observedAtMs: 1_500, source: 'car', sourceDeviceId: 'car-1' }),
    });
    expect(resolved).toMatchObject({ percent: 63, source: 'car', sourceDeviceId: 'car-1' });
  });

  // The car is the identity, not the charger. A car that unplugs and plugs back
  // in has not changed its charge, and it publishes its own level independently
  // of this charger (and is re-read on every targeted refresh), so "nothing new
  // since the replug" means the level has not moved. Voiding it here would blank
  // the level of a car replugged at the level it left at, for as long as that
  // level stayed put — and a charger-owned reading is voided precisely because
  // it identifies no particular car.
  it('keeps a car-sourced level across a replug, unlike a charger-owned one', () => {
    const snapshot = {
      id: 'charger-1',
      name: 'Elbillader',
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_charging',
      evCharging: true,
      targets: [],
    } as unknown as Parameters<typeof updateStateOfChargeFromCarObservation>[0]['snapshot'];

    // A reading the car took BEFORE this charging session was anchored.
    updateStateOfChargeFromCarObservation({
      snapshot, percent: 63, observedAtMs: 1_000, carId: 'car-1', nowMs: 5_000,
    });
    snapshot.stateOfCharge = { ...snapshot.stateOfCharge!, sessionStartedAtMs: 4_000 };
    updateStateOfChargeFromCarObservation({
      snapshot, percent: 63, observedAtMs: 1_000, carId: 'car-1', nowMs: 5_000,
    });

    expect(snapshot.stateOfCharge?.level).toEqual({ kind: 'known', percent: 63 });
  });

  it('never carries a charger-owned level forward as if a car had reported it', () => {
    // The toggle may have been switched on while one of the charger's own
    // readings was still present; adopting it would relabel someone else's data.
    expect(resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: 2_000,
      capabilityObj: chargerCaps,
      reportedCapabilities: {},
      eligibleCarIds: ['car-1'],
      retainedStateOfCharge: stateOfChargeFixture({ percent: 71, observedAtMs: 1_500 }),
    })).toBeUndefined();
  });

  it('writes a car reading onto the charger and drops it when the session ends', () => {
    const snapshot = {
      id: 'charger-1',
      name: 'Elbillader',
      deviceClass: 'evcharger',
      evChargingState: 'plugged_in_charging',
      evCharging: true,
      targets: [],
    } as unknown as Parameters<typeof updateStateOfChargeFromCarObservation>[0]['snapshot'];

    expect(updateStateOfChargeFromCarObservation({
      snapshot, percent: 63, observedAtMs: 1_500, carId: 'car-1', nowMs: 1_600,
    })).toBe(true);
    expect(snapshot.stateOfCharge).toMatchObject({
      percent: 63, source: 'car', sourceDeviceId: 'car-1', capabilityId: 'measure_battery',
    });
    // The car's own observation time, never `now` — stamping `now` would make a
    // two-day-old reading read fresh.
    expect(snapshot.stateOfCharge?.observedAtMs).toBe(1_500);

    expect(clearCarStateOfCharge({ snapshot })).toBe(true);
    expect(snapshot.stateOfCharge).toBeUndefined();
  });

  it('leaves a charger-owned level alone when a session ends', () => {
    const snapshot = {
      id: 'charger-1', name: 'Elbillader', deviceClass: 'evcharger', targets: [],
      stateOfCharge: stateOfChargeFixture({ percent: 71, observedAtMs: 1_000 }),
    } as unknown as Parameters<typeof clearCarStateOfCharge>[0]['snapshot'];
    expect(clearCarStateOfCharge({ snapshot })).toBe(false);
    expect(snapshot.stateOfCharge).toMatchObject({ percent: 71 });
  });
});
