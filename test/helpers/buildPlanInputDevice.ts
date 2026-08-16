import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveResidualKwShed } from '../../lib/device/deviceResidualKw';
import { fixtureCurrentDrawKw, fixtureExpectedPowerKw } from '../utils/planTestUtils';

/**
 * Test fixture builder for `PlanInputDevice`. Applies a small set of safe
 * defaults so call sites only need to specify what's relevant to the test.
 *
 * Defaults:
 *   - `name` falls back to `id`
 *   - `targets` defaults to `[]`
 *   - `binaryControl` defaults to `{ on: true }` (the old fabricated `currentOn: true`)
 *   - `shedIntent` defaults to `{ kind: 'turn_off' }` (the post-PR-A required
 *     field; tests that care about a specific intent override it)
 *   - `currentDrawKw` is resolved by the production resolver from whatever
 *     power fields the fixture declares
 *
 * Every other `PlanInputDevice` field is left `undefined` unless supplied via
 * `overrides`, so tests never accidentally rely on a fabricated value.
 *
 * Existing inline fixtures (e.g. the local `buildEvDevice` in
 * `test/unit/deferredObjectiveAdmission.unit.test.ts`) follow the same shape; this
 * helper centralises the pattern so the upcoming planner-detype refactor can
 * add fields without churning every fixture by hand.
 */
export function buildPlanInputDevice(
  overrides: Partial<PlanInputDevice> & {
    id: string;
    /** Legacy fixture alias for `currentDrawKw`; the raw field is gone from the contract. */
    measuredPowerKw?: number;
    binaryControl?: { on: boolean };
    currentOn?: boolean;
  },
): PlanInputDevice {
  // The `binaryControl` default is preserved verbatim, so this is the canonical
  // fixture-constructor boundary (NOT a per-test smuggle): the cast keeps the
  // exact runtime shape callers rely on rather than routing through
  // `withBinaryDiscriminant`, whose runtime stripping (binaryControl omitted
  // without `binaryCapabilityId`) would change every consumer's fixture.
  const {
    available, commandableNow, controllable, measuredPowerKw, currentDrawKw, ...rest
  } = overrides;
  return {
    name: overrides.id,
    targets: [],
    binaryControl: { on: true },
    ...rest,
    // Producer-resolved draw, DELEGATED to the production resolver via
    // `fixtureCurrentDrawKw`. It used to default to a hardcoded 1 kW — the
    // deleted `DEFAULT_FALLBACK_KW` by another name — so every spec using this
    // builder without an explicit draw exercised a device production would
    // resolve to 0 and refuse as a shed candidate.
    //
    // Stamped AFTER the caller spread and destructured out of `rest`, so an
    // explicit `currentDrawKw: undefined` cannot ship a required field as
    // missing — which is exactly how four fixtures came to carry `undefined`.
    currentDrawKw: fixtureCurrentDrawKw({ ...overrides, currentDrawKw, measuredPowerKw }),
    expectedPowerKw: fixtureExpectedPowerKw(overrides),
    // Same treatment, same reason: the contract makes the source REQUIRED, and
    // this builder's cast is the one place that could still ship it absent.
    // `'default'` is what the producer emits for a device nothing is known
    // about — which is exactly the fixture `fixtureExpectedPowerKw` resolves.
    expectedPowerSource: overrides.expectedPowerSource ?? 'default',
    controllable: controllable ?? true,
    available: available ?? true,
    // Required base field: resolve it the way the producer does rather than
    // leaving it undefined, so no consumer can read absence as "not commandable".
    // Spread LAST and `??`-guarded so an explicit `commandableNow: undefined`
    // override cannot erase the required field, while an explicit `false` stands.
    commandableNow: commandableNow ?? resolveCommandableNow({ ...rest, available: available ?? true }),
    // Required since the dual-read collapse: the producer always stamps
    // `residualKw`, so a fixture without one is a shape production never emits.
    // Resolved through the SAME function the producer uses
    // (`resolveResidualKwShed`) rather than defaulted to the draw, so a stepped
    // fixture already at its off step still resolves to 0 — the answer the
    // deleted kind-switch fallback used to compute at the consumer. `turn_off`
    // is the behaviour the producer assumes when nothing else is configured.
    residualKw: overrides.residualKw ?? {
      shed: resolveResidualKwShed({
        device: fixtureResidualShedInput({
          ...overrides,
          currentDrawKw: fixtureCurrentDrawKw({ ...overrides, currentDrawKw, measuredPowerKw }),
        }),
        shedBehavior: { action: 'turn_off' },
      }),
    },
  } as unknown as PlanInputDevice;
}

/**
 * Resolve a fixture's `residualKw` through the SAME function the producer uses
 * (`resolveResidualKwShed`). Exported because several specs keep their own
 * local device builder; they must not re-derive this by hand, or a stepped
 * fixture already at its off step would claim relief it cannot deliver.
 * `turn_off` is the behaviour the producer assumes when nothing else is
 * configured.
 */
export function fixtureResidualKw(
  device: Record<string, unknown> & { currentDrawKw?: number },
): { shed: number } {
  return {
    shed: resolveResidualKwShed({
      // A fixture that declares no draw draws nothing, and shedding nothing
      // frees nothing — the same answer `fixtureCurrentDrawKw` resolves.
      device: fixtureResidualShedInput({ ...device, currentDrawKw: device.currentDrawKw ?? 0 }),
      shedBehavior: { action: 'turn_off' },
    }),
  };
}

// Mirrors `toResidualSteppedLoad` / `toResidualTemperatureTarget` in
// `setup/appInit/residualKwForPlanDevice.ts`, reading the fields a fixture
// declares instead of a `DecoratedDeviceSnapshot`.
function fixtureResidualShedInput(device: Record<string, unknown> & { currentDrawKw: number }) {
  const steppedLoadProfile = device.steppedLoadProfile as
    { steps?: { id: string }[] } | undefined;
  const temperatureTarget = Array.isArray(device.targets)
    && (device.targets as { id?: string }[]).some((t) => t?.id === 'target_temperature')
    ? { currentValue: device.currentTarget as number | undefined }
    : undefined;
  return {
    currentDrawKw: device.currentDrawKw,
    ...(temperatureTarget ? { temperatureTarget } : {}),
    ...(steppedLoadProfile
      ? {
        steppedLoad: {
          profile: steppedLoadProfile as never,
          selectedStepId: device.selectedStepId as string | undefined,
          hasKnownEffectiveStep: device.selectedStepId !== undefined,
          currentDrawKw: device.currentDrawKw,
          hasBinaryControl: device.binaryCapabilityId !== undefined,
        },
      }
      : {}),
  };
}
