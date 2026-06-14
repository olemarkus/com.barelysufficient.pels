import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CapacityGuard from '../../lib/power/capacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildSheddingPlan } from '../../lib/plan/shedding';

// Regression coverage for the shed-candidacy writability gate.
//
// A device that survives the capability gate via a target capability but has no
// resolvable binary control (`controlCapabilityId === undefined` — e.g. a
// thermostat on the default `turn_off` shed behaviour that lost its `onoff`
// capability) must NOT be offered as a binary shed candidate: the executor would
// no-op the turn_off (`getBinaryControlPlan === null`), so crediting its power in
// the cascade wastes the shed slot and leaves the overshoot unrelieved while a
// writable, lower-priority device goes unshed.

const buildContext = (devices: PlanInputDevice[], headroom: number): PlanContext => ({
  devices,
  desiredForMode: {},
  total: 6,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  softLimit: 4,
  capacitySoftLimit: 4,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  hourBucketKey: '2026-01-01T00',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: headroom,
  headroom,
  restoreMarginPlanning: 0.2,
});

const buildDeps = (state: ReturnType<typeof createPlanEngineState>, capacityGuard: CapacityGuard) => ({
  capacityGuard,
  powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
  pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
  // Cap-less device sorts first (higher number sheds first).
  getPriorityForDevice: (id: string) => (id === 'unwritable' ? 200 : 100),
  log: vi.fn(),
  debugStructured: vi.fn(),
});

const buildCapacityGuard = (): CapacityGuard => ({
  isSheddingActive: vi.fn().mockReturnValue(false),
  setSheddingActive: vi.fn().mockResolvedValue(undefined),
  checkShortfall: vi.fn().mockResolvedValue(undefined),
  isInShortfall: vi.fn().mockReturnValue(false),
  getShortfallThreshold: vi.fn().mockReturnValue(6),
  getRestoreMargin: vi.fn().mockReturnValue(0.2),
} as unknown as CapacityGuard);

// A thermostat-class device that survives the capability gate (target +
// measure_temperature) but lost `onoff`. Its control capability is gone this
// cycle, so the producer revokes binary status (`controlCapabilityId` undefined,
// `binaryControl` undefined — see `resolveBinaryControl`) while `resolvedOn`
// keeps it managed. Its default shed behaviour is turn_off, so it still routes
// through the binary candidate path despite being unwritable.
const capLessTargetBearing: PlanInputDevice = {
  id: 'unwritable',
  name: 'Heater (lost onoff)',
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  controlCapabilityId: undefined,
  controllable: true,
  expectedPowerKw: 2,
} as unknown as PlanInputDevice;

const writableBinary: PlanInputDevice = {
  id: 'writable',
  name: 'Socket',
  targets: [],
  controlCapabilityId: 'onoff',
  binaryControl: { on: true },
  currentOn: true,
  controllable: true,
  expectedPowerKw: 2,
} as unknown as PlanInputDevice;

describe('shed candidacy gates on writability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('sheds the writable device, not a cap-less target-bearing one credited first', async () => {
    const state = createPlanEngineState();
    const result = await buildSheddingPlan(
      buildContext([capLessTargetBearing, writableBinary], -2),
      state,
      buildDeps(state, buildCapacityGuard()),
      true,
    );

    // The writable device is the only one PELS can actually turn off, so it must
    // be the one shed to relieve the overshoot.
    expect(result.shedSet.has('writable')).toBe(true);
    // The cap-less device must not consume the shed slot.
    expect(result.shedSet.has('unwritable')).toBe(false);
  });

  it('does not shed a cap-less target-bearing device even when it is the only candidate', async () => {
    const state = createPlanEngineState();
    const result = await buildSheddingPlan(
      buildContext([capLessTargetBearing], -2),
      state,
      buildDeps(state, buildCapacityGuard()),
      true,
    );

    // Nothing writable to shed: the cap-less device is excluded rather than
    // credited as phantom relief.
    expect(result.shedSet.size).toBe(0);
  });
});
