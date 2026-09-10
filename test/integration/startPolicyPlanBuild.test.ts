import { describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { inputDevice } from '../utils/planConvergenceFixtures';

/**
 * The "Only PELS starts this device" policy, driven through a WHOLE plan build.
 *
 * This spec exists because the first version of the feature was proved only by
 * unit tests on the hold resolver and by `buildInitialPlanDevices` in isolation.
 * Both bypass `finalizePlanDevices`, and therefore bypassed
 * `validatePlanReasonPair` — which rejects any reason code not listed as legal
 * for the device's planned state. The reason was missing from `SHED_REASON_RULES`,
 * so every `pels_only` device threw in test and would have logged
 * `plan_reason_pair_invalid` on every production build, forever, for a state that
 * is permanent by design.
 *
 * The lesson is the assertion: a new plan reason is not landed until a full build
 * has produced it.
 */

const buildBuilder = (): PlanBuilder => new PlanBuilder({
  getInferredSurplusKw: () => 0,
  getCapacityDryRun: () => false,
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  // Deliberately roomy: no capacity pressure anywhere, so the only thing that can
  // put a device in the shed set is the posture under test.
  getCapacitySettings: () => ({ limitKw: 50, marginKw: 0.2 }),
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
  getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 500 }),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getDynamicSoftLimitOverride: () => 50,
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  // No smart tasks in this suite: the point is what the policy does on its
  // own, so nothing is ever in the actively-driven set.
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
}, createPlanEngineState());

const charger = (startPolicy: 'unrestricted' | 'pels_only'): PlanInputDevice => inputDevice({
  id: 'charger',
  name: 'Charger',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  currentState: 'on',
  currentDrawKw: 1,
  expectedPowerKw: 1,
  // The case the feature exists for: managed, but the owner has Power-limit
  // control OFF. The policy is what gives PELS the lever at all.
  controllable: false,
  managed: true,
  commandAuthority: startPolicy === 'pels_only',
  startPolicy,
});

describe('start policy through a whole plan build', () => {
  it('produces a valid finalized plan for a pels_only device', async () => {
    // `validatePlanReasonPair` throws in the test tiers, so reaching the
    // assertion at all is half of what this proves.
    const plan = await buildBuilder().buildDevicePlanSnapshot([charger('pels_only')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason?.code).toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });

  it('leaves an unrestricted device alone when nothing is pressing on capacity', async () => {
    const plan = await buildBuilder().buildDevicePlanSnapshot([charger('unrestricted')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).not.toBe('shed');
    expect(device?.reason?.code).not.toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });
});
