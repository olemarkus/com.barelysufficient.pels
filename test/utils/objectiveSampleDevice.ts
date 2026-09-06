import { getCurrentDrawKw } from '../../lib/observer/observedPower';
import {
  resolveObjectiveObservedQuantity,
  type ObjectiveObservedQuantity,
  type ObjectiveQuantityDevice,
} from '../../packages/shared-domain/src/objectiveObservedQuantity';
import type { MeasuredPowerObservedProbe } from '../../packages/contracts/src/types';

/**
 * Test-side twin of the production producer boundary
 * (`setup/powerSamplePipeline.ts` → `withHeadroomCurrentOn`): an objectives
 * fixture states what the device's METER reads, and this resolves that to the
 * `currentDrawKw` the objectives contract requires.
 *
 * Fixtures deliberately do NOT set `currentDrawKw` directly. Going through the
 * real resolver is what keeps them exercising production's collapse of an
 * absent / rejected reading to `0` — the behaviour
 * `resolveCredibleDevicePower`'s credibility threshold depends on.
 */
export const withResolvedCurrentDraw = <
  T extends MeasuredPowerObservedProbe
    & ObjectiveQuantityDevice
    & { available?: boolean; lastFreshDataMs?: number },
>(
  device: T,
): T & {
  available: boolean;
  currentDrawKw: number;
  observedQuantity: ObjectiveObservedQuantity;
} => ({
  ...device,
  available: device.available ?? true,
  currentDrawKw: getCurrentDrawKw(device),
  // Mirrors the production seam (`setup/powerSamplePipeline.ts`) by calling the
  // same resolver, so fixtures exercise the real mapping rather than hand-feeding
  // the contract.
  observedQuantity: resolveFixtureQuantity(device),
});

// The production seam drops a device with nothing to sample before the
// objectives layer sees it, so a fixture that reaches this helper is asserting it
// HAS a reading. Failing loudly beats handing the contract an absence it no
// longer models — a fixture without temperature or state of charge is a mistake
// in the test, not a case the layer has to carry.
const resolveFixtureQuantity = (
  device: ObjectiveQuantityDevice & { lastFreshDataMs?: number },
): ObjectiveObservedQuantity => {
  const quantity = resolveObjectiveObservedQuantity({
    device,
    deviceObservedAtMs: device.lastFreshDataMs,
  });
  if (!quantity) {
    throw new Error(
      'objective fixture has neither an observed temperature nor a state of charge: '
      + 'the production seam would not pass it to lib/objectives at all',
    );
  }
  return quantity;
};
