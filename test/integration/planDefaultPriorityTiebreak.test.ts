import { buildSheddingCandidates } from '../../lib/plan/shedding/candidates';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { ShedCandidateParams } from '../../lib/plan/shedding/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanInputDevice, DevicePlanDevice } from '../../lib/plan/planTypes';
import { getRestoreCandidates, getOffDevices } from '../../lib/plan/restore/devices';

// Two managed devices that were never assigned a stored priority, drawing the
// SAME effective power. Without a deterministic final tiebreak their relative
// order in shed and restore arbitration would depend on input order (and shed
// vs restore could disagree). These tests pin a single, stable deviceId order
// on BOTH sides.

const buildShedDevice = (id: string): PlanInputDevice => ({
  id,
  name: id,
  targets: [],
  controllable: true,
  // Real parse output resolves a binary control capability for a sheddable
  // device; shed candidacy gates on writability (`isCanSetControl`).
  controlCapabilityId: 'onoff',
  binaryControl: { on: true },
  measuredPowerKw: 1.5,
});

const buildShedParams = (devices: PlanInputDevice[]): ShedCandidateParams => ({
  devices,
  needed: 1,
  limitSource: 'capacity',
  total: 10,
  capacitySoftLimit: 5,
  state: createPlanEngineState(),
  deps: {
    capacityGuard: undefined,
    powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    // No stored priority for any device → caller-side default for the whole bucket.
    getPriorityForDevice: () => 100,
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    log: () => {},
  },
});

const buildRestoreDevice = (id: string): DevicePlanDevice => ({
  id,
  name: id,
  currentState: 'off',
  plannedState: 'keep',
  controlCapabilityId: 'onoff',
  // priority intentionally omitted → default bucket.
} as DevicePlanDevice);

describe('default-priority deterministic tiebreak (shed & restore)', () => {
  it('orders default-priority, equal-power shed candidates deterministically regardless of input order', () => {
    const forward = buildSheddingCandidates(buildShedParams([
      buildShedDevice('alpha'),
      buildShedDevice('bravo'),
      buildShedDevice('charlie'),
    ]));
    const reversed = buildSheddingCandidates(buildShedParams([
      buildShedDevice('charlie'),
      buildShedDevice('bravo'),
      buildShedDevice('alpha'),
    ]));

    const forwardIds = forward.candidates.map((c) => c.id);
    const reversedIds = reversed.candidates.map((c) => c.id);

    expect(forwardIds).toEqual(['alpha', 'bravo', 'charlie']);
    expect(reversedIds).toEqual(forwardIds);
  });

  it('orders default-priority restore candidates deterministically regardless of input order', () => {
    const forward = getRestoreCandidates([
      buildRestoreDevice('alpha'),
      buildRestoreDevice('bravo'),
      buildRestoreDevice('charlie'),
    ]);
    const reversed = getRestoreCandidates([
      buildRestoreDevice('charlie'),
      buildRestoreDevice('bravo'),
      buildRestoreDevice('alpha'),
    ]);

    const forwardIds = forward.map((c) => c.device.id);
    const reversedIds = reversed.map((c) => c.device.id);

    expect(forwardIds).toEqual(['alpha', 'bravo', 'charlie']);
    expect(reversedIds).toEqual(forwardIds);
  });

  it('orders default-priority off-device restore (sortByPriorityAsc) deterministically regardless of input order', () => {
    const forward = getOffDevices([
      buildRestoreDevice('alpha'),
      buildRestoreDevice('bravo'),
      buildRestoreDevice('charlie'),
    ]).map((d) => d.id);
    const reversed = getOffDevices([
      buildRestoreDevice('charlie'),
      buildRestoreDevice('bravo'),
      buildRestoreDevice('alpha'),
    ]).map((d) => d.id);

    expect(forward).toEqual(['alpha', 'bravo', 'charlie']);
    expect(reversed).toEqual(forward);
  });

  it('keeps configured priority dominant over the deviceId tiebreak in shed', () => {
    // Stored priority must still drive ordering; the deviceId tiebreak only
    // breaks ties within an equal-priority bucket.
    const params = buildShedParams([
      buildShedDevice('alpha'),
      buildShedDevice('zulu'),
    ]);
    // zulu has a LOWER stored priority number → sheds LAST (higher number sheds
    // first). Despite 'zulu' > 'alpha' lexically, priority wins.
    params.deps.getPriorityForDevice = (id) => (id === 'zulu' ? 1 : 9);
    const ids = buildSheddingCandidates(params).candidates.map((c) => c.id);
    expect(ids).toEqual(['alpha', 'zulu']);
  });
});
