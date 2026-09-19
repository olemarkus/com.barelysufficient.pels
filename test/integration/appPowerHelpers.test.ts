import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  recordDailyBudgetCap,
  recordPowerSampleForApp,
  type SumBudgetExemptUsage,
  type UpdateObjectiveProfiles,
} from '../../lib/power/sampleIngest';
import {
  PowerCalibrationStore,
  createCalibrationSnapshotMutationHook,
} from '../../lib/device/devicePowerCalibrationStore';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import { updateObjectiveProfilesFromSnapshot } from '../../lib/objectives/profiles';
import { resolveObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';

// Mirror the production wiring in `setup/powerSamplePipeline.ts`: raw transport
// snapshots go through `withHeadroomCurrentOn` — the producer boundary that
// resolves `currentDrawKw` and `currentOn` for the projected exemption seam.
// Injecting the bare plan helpers would hand them un-resolved snapshots the
// runtime never produces.
const sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
  sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
);

describe('recordDailyBudgetCap', () => {
  it('returns existing state for invalid snapshots', () => {
    const wrapUiPayload = (day: unknown) => ({
      days: { '2024-01-01': day },
      todayKey: '2024-01-01',
    });
    const cases = [
      null,
      wrapUiPayload({ budget: { enabled: false } }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: 'nope', startUtc: [] }, currentBucketIndex: 0 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [1], startUtc: ['2024-01-01T00:00:00.000Z'] }, currentBucketIndex: 2 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [Number.NaN], startUtc: ['2024-01-01T00:00:00.000Z'] }, currentBucketIndex: 0 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [1], startUtc: [123] }, currentBucketIndex: 0 }),
    ];

    cases.forEach((snapshot) => {
      const powerTracker: PowerTrackerState = { dailyBudgetCaps: { existing: 1 } };
      const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as unknown as DailyBudgetUiPayload });
      expect(result).toBe(powerTracker);
    });
  });

  it('stores the planned cap for the current bucket', () => {
    const bucketKey = '2024-01-01T00:00:00.000Z';
    const powerTracker: PowerTrackerState = { dailyBudgetCaps: { existing: 1 } };
    const snapshot = {
      days: {
        '2024-01-01': {
          budget: { enabled: true },
          buckets: { plannedKWh: [2.5], startUtc: [bucketKey] },
          currentBucketIndex: 0,
        },
      },
      todayKey: '2024-01-01',
    };

    const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as unknown as DailyBudgetUiPayload });
    expect(result).not.toBe(powerTracker);
    expect(result.dailyBudgetCaps).toEqual({ existing: 1, [bucketKey]: 2.5 });
  });
});

describe('recordPowerSampleForApp', () => {
  it('records measured budget exempt usage into exempt buckets', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'dev-budget',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Budget exempt heater',
        targets: [],
        measuredPowerKw: 0.4,
        budgetExempt: true,
      },
      {
        available: true,
        id: 'dev-other',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Other heater',
        targets: [],
        measuredPowerKw: 0.6,
        budgetExempt: false,
      },
    ]);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 1000,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 1000,
      nowMs: start + 30 * 60 * 1000,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBeCloseTo(0.2, 3);
  });

  it('keeps an OFF exempt device claiming its configured demand on the daily axis', async () => {
    // The exempt projection is a reservation, not a measurement stand-in: the
    // daily-pace add-back has to survive the device's duty cycle. Note the
    // trigger is being observed OFF — a running exempt device measuring 0 books 0.
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'dev-budget',
        name: 'Budget exempt heater',
        targets: [],
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        measuredPowerKw: 0,
        expectedPowerKw: 0.8,
        expectedPowerSource: 'default' as const,
        budgetExempt: true,
      },
    ]);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 800,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 800,
      nowMs: start + 30 * 60 * 1000,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBeCloseTo(0.4, 3);
  });

  it('does not record budget-exempt buckets for devices with capacity control disabled', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'dev-budget',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Budget exempt heater',
        targets: [],
        measuredPowerKw: 0.8,
        budgetExempt: true,
        controllable: false,
      },
    ]);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 800,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 800,
      nowMs: start + 30 * 60 * 1000,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBe(0);
  });

  // Membership in the per-device buckets is a PRESENCE question and nothing
  // else. Homey reports capabilities on change, so an unchanged reading is the
  // current reading however old its timestamp — the per-capability age gate that
  // used to sit here dropped a legitimately-steady device out of its own bucket
  // for as long as it stayed correct (prod thermostat, true 0 W for 16 h). What
  // still must NOT be bucketed is a device with no meter at all: booking it at 0
  // would claim it used nothing, when the truth is PELS cannot see it and its
  // consumption belongs in the "Other" remainder.
  it('records per-device buckets from any present measured reading, and none without one', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'fresh-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Fresh heater',
        targets: [],
        measuredPowerKw: 1.2,
        measuredPowerObservedAtMs: observedAtMs,
      },
      {
        available: true,
        id: 'steady-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Steady heater (unchanged for over a minute)',
        targets: [],
        measuredPowerKw: 0.8,
        measuredPowerObservedAtMs: observedAtMs - 61_000,
      },
      {
        available: true,
        id: 'timestampless-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Heater whose capability carries no timestamp',
        targets: [],
        measuredPowerKw: 0.9,
      },
      {
        available: true,
        id: 'estimated-heater',
        name: 'Estimated heater',
        targets: [],
        expectedPowerKw: 0.5,
        expectedPowerSource: 'default' as const,
      },
    ]);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 2500,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    observedAtMs = start + 30 * 60 * 1000;
    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 2500,
      nowMs: start + 30 * 60 * 1000,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.deviceBuckets?.['fresh-heater']?.[bucketKey]).toBeCloseTo(0.6, 3);
    expect(tracker.deviceBuckets?.['steady-heater']?.[bucketKey]).toBeCloseTo(0.4, 3);
    expect(tracker.deviceBuckets?.['timestampless-heater']?.[bucketKey]).toBeCloseTo(0.45, 3);
    expect(tracker.deviceBuckets?.['estimated-heater']).toBeUndefined();
  });

  it('records measured zero as a per-device bucket', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'idle-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Idle heater',
        targets: [],
        measuredPowerKw: 0,
        measuredPowerObservedAtMs: observedAtMs,
      },
    ]);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 500,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    observedAtMs = start + 30 * 60 * 1000;
    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 500,
      nowMs: start + 30 * 60 * 1000,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.deviceBuckets?.['idle-heater']?.[bucketKey]).toBe(0);
  });

  it('leaves controlled power unknown when no snapshot devices are available', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 1000,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot: () => [],
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    expect(tracker.lastControlledPowerW).toBeUndefined();
    expect(tracker.lastUncontrolledPowerW).toBeUndefined();
  });

  it('updates objective profiles from compact device samples during power ingestion', async () => {
    let tracker: PowerTrackerState = {};
    const debugStructured = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let currentTemperature = 50;
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => {
      const target = { id: 'target_temperature' as const, value: 55, unit: '°C' };
      return [{
        available: true,
        id: 'heater-objective',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Objective heater',
        targets: [target],
        deviceType: 'temperature' as const,
        binaryControl: { on: true },
        temperature: { currentTemperature, target },
        lastFreshDataMs: observedAtMs,
        measuredPowerKw: 2,
      }];
    };

    // Mirrors the production wiring (`setup/powerSamplePipeline.ts`): the raw
    // snapshots go through the producer boundary so the profile sees a resolved
    // `currentDrawKw`, not a raw `measuredPowerKw`, and the objectives seam's
    // `observedAtMs` stamped from the transport's `lastFreshDataMs`.
    const updateProfiles: UpdateObjectiveProfiles = (params) => (
      updateObjectiveProfilesFromSnapshot({
        ...params,
        devices: params.devices.flatMap((device) => {
          const observedQuantity = resolveObjectiveObservedQuantity({
            device,
            deviceObservedAtMs: device.lastFreshDataMs,
          });
          return observedQuantity === null
            ? []
            : [{ ...withHeadroomCurrentOn(device), observedQuantity }];
        }),
        debugStructured,
      })
    );

    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 2000,
      nowMs: start,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: updateProfiles,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    currentTemperature = 52;
    observedAtMs = start + 60 * 60 * 1000;
    await recordPowerSampleForApp({
      generationSegments: [],
      currentPowerW: 2000,
      nowMs: observedAtMs,
      timeZone: 'UTC',
      capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: updateProfiles,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const profile = tracker.objectiveProfiles?.['heater-objective'];
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(1, 3);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(2, 3);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_recorded',
      deviceId: 'heater-objective',
    }));
  });

  // Gross consumption during EXPORT with no co-sampled production reading.
  // `net + generation` cannot resolve gross from a negative net when generation
  // is absent, and `max(0, net)` would assert the home consumed nothing — which
  // zeroes the managed/background split while devices are demonstrably drawing.
  describe('gross consumption on a negative net sample', () => {
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const drawingSnapshot = (observedAtMs: number) => () => ([
      {
        id: 'heater-a',
        expectedPowerKw: 1,
        name: 'Heater A',
        targets: [],
        measuredPowerKw: 1.2,
        measuredPowerObservedAtMs: observedAtMs,
      },
      {
        id: 'heater-b',
        expectedPowerKw: 1,
        name: 'Heater B',
        targets: [],
        measuredPowerKw: 0.8,
        measuredPowerObservedAtMs: observedAtMs,
      },
    ]);

    const record = async (params: {
      currentPowerW: number;
      generationW?: number;
      getLatestTargetSnapshot: () => never[] | ReturnType<ReturnType<typeof drawingSnapshot>>;
    }): Promise<PowerTrackerState> => {
      let tracker: PowerTrackerState = {};
      await recordPowerSampleForApp({
        generationSegments: [],
        currentPowerW: params.currentPowerW,
        ...(params.generationW !== undefined ? { generationW: params.generationW } : {}),
        nowMs: start,
        timeZone: 'UTC',
        capacitySettings: { limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
        getLatestTargetSnapshot: params.getLatestTargetSnapshot as never,
        powerTracker: {},
        sumBudgetExemptUsage,
        updateObjectiveProfiles: ({ state }) => state,
        schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
        saveState: (nextState) => {
          tracker = nextState;
        },
      });
      return tracker;
    };

    it('attributes the measured device draw instead of reporting a 0 kW home', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      // 1.2 + 0.8 kW of measured managed draw survives the export sample.
      expect(tracker.lastControlledPowerW).toBe(2000);
      // Background load is genuinely unobservable without a production reading,
      // so it stays 0 — a floor, not a claim.
      expect(tracker.lastUncontrolledPowerW).toBe(0);
      // The billed total keeps net, floored — export is not negative energy.
      expect(tracker.lastPowerW).toBe(-1500);
    });

    it('never attributes a non-controllable device\'s draw to a managed device', async () => {
      // The floor must be summed over the SAME set the split attributes over.
      // A home battery is real draw but `controllable: false`, so it is excluded
      // from the controlled sum — while the controllable heater contributes its
      // own measured 2 kW. A floor built from raw measured device draw would hand
      // the battery's 2 kW to the split, which would then record it as 2 kW of
      // HEATER usage with 0 background: the wrong device credited for watts it
      // never drew.
      const tracker = await record({
        currentPowerW: -1000,
        getLatestTargetSnapshot: () => ([
          {
            id: 'home-battery',
            expectedPowerKw: 1,
            name: 'Home battery',
            targets: [],
            controllable: false,
            measuredPowerKw: 2,
            measuredPowerObservedAtMs: start,
          },
          {
            id: 'heater-estimated',
            name: 'Heater',
            targets: [],
            measuredPowerKw: 2,
            expectedPowerKw: 2,
          },
        ]) as never,
      });

      // Only the heater's own measured 2 kW is attributed — the battery's draw
      // is not laundered into the managed bucket.
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('reports 0 when no fresh measured draw is available to floor at', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        getLatestTargetSnapshot: () => [],
      });
      expect(tracker.lastControlledPowerW).toBeUndefined();
      expect(tracker.lastPowerW).toBe(-1500);
    });

    it('still prefers net + generation when a production reading is co-sampled', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 4000,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      // gross = -1500 + 4000 = 2500 W, so the split measures against 2.5 kW and
      // the 2 kW of managed draw leaves 0.5 kW of background — NOT the 2 kW
      // floor, proving the floor never displaces an authoritative reading.
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(500);
    });

    it('falls back when a co-sampled production reading cannot explain the export', async () => {
      // A solar home carries generation on EVERY sample now, including `0` at
      // night. `0` is still a reading, so a presence check would send this home
      // back to "consumed nothing" — the exact answer the fallback exists to
      // prevent — on the source that just gained production. Exporting under
      // zero reported production is real: a battery discharging to grid after
      // dark, or a second inverter Homey cannot see.
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 0,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('still prefers net + generation when the two together are positive', async () => {
      // Partial cover: 3 kW of production against a 1.5 kW export means the home
      // really is drawing 1.5 kW, and that authoritative figure must win over
      // the measured-draw floor.
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 3000,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(1500);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('leaves a positive net sample byte-identical', async () => {
      const tracker = await record({
        currentPowerW: 2500,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(500);
    });
  });

});

describe('createCalibrationSnapshotMutationHook', () => {
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const makeSnapshot = (
    overrides: Partial<
      TargetDeviceSnapshot & MeasuredPowerObservedProbe
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    > = {},
  ): TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe => ({
    id: 'hoiax-1',
    expectedPowerKw: 1,
    name: 'Connected 300',
    targets: [],
    controlModel: 'stepped_load',
    steppedLoadProfile: {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'medium', planningPowerW: 1750 },
      ],
    },
    reportedStepId: 'low',
    measuredPowerKw: 1.1,
    binaryControl: { on: true },
    lastFreshDataMs: start,
    ...overrides,
  } as TargetDeviceSnapshot);

  it('emits a per-sample accepted event when the sample lands inside the band', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_accepted',
      deviceId: 'hoiax-1',
      stepId: 'low',
      measuredPowerKw: 1.1,
    }));
  });

  it('emits a per-sample skipped event when the sample exceeds the configured step', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.81 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_skipped',
      deviceId: 'hoiax-1',
      reason: 'above_step_ceiling',
    }));
  });

  it('stays silent when the snapshot is ineligible for calibration', () => {
    const store = new PowerCalibrationStore();
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ reportedStepId: undefined }), start);
    expect(debugStructured).not.toHaveBeenCalled();
  });

  it('debounces repeat samples for the same (device, step) inside the cadence floor', () => {
    // EV chargers and inverter heaters can publish measure_power every 1-2 s;
    // without this debounce, EMA `alpha` would saturate to MIN_ALPHA within
    // ~30 s of operation and stop responding to legitimate drift.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start);
    hook(makeSnapshot({ measuredPowerKw: 1.12 }), start + 1_000);
    hook(makeSnapshot({ measuredPowerKw: 1.15 }), start + 5_000);
    expect(debugStructured).toHaveBeenCalledTimes(1);
    hook(makeSnapshot({ measuredPowerKw: 1.2 }), start + 31_000);
    expect(debugStructured).toHaveBeenCalledTimes(2);
  });

  it('does not debounce after an ineligible call — first eligible sample still lands', () => {
    // Regression: previously the debounce cursor was advanced before the
    // eligibility check, so an ineligible first call (e.g. stepCommandPending,
    // assumed step) would swallow the next valid sample for up to
    // minIntervalMs — exactly the startup/step-change transitions this hook
    // is meant to capture.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ reportedStepId: undefined, measuredPowerKw: 1.1 }), start);
    expect(debugStructured).not.toHaveBeenCalled();
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledTimes(1);
  });

  it('does not debounce after a rejected sample — first accepted sample still lands', () => {
    // Regression: a rejected outcome (stale_observation, above_step_ceiling,
    // etc.) leaves the store untouched, so advancing the debounce cursor
    // would swallow the next valid sample without protecting anything in
    // return. The debounce exists only to stop accepted-sample chatter from
    // saturating EMA `alpha`.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    // First call: above-step-ceiling rejection.
    hook(makeSnapshot({ measuredPowerKw: 1.81 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_skipped',
      reason: 'above_step_ceiling',
    }));
    debugStructured.mockClear();
    // Second call: valid sample 1 s later. Must not be debounced.
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_accepted',
    }));
  });

  it('debounces per (device, step) independently', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ reportedStepId: 'low', measuredPowerKw: 1.1 }), start);
    hook(makeSnapshot({ reportedStepId: 'medium', measuredPowerKw: 1.6 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledTimes(2);
  });
});
