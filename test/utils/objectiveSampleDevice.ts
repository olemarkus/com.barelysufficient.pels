import { getCurrentDrawKw } from '../../lib/observer/observedPower';
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
export const withResolvedCurrentDraw = <T extends MeasuredPowerObservedProbe>(
  device: T,
): T & { currentDrawKw: number } => ({
  ...device,
  currentDrawKw: getCurrentDrawKw(device),
});
