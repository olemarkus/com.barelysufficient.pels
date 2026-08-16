/**
 * Coverage for `toPlanDevice`'s BOOST wiring — the producer seam that turns a
 * device's ladder, drivability, configured floor and live reading into the two
 * flat bits the planner plans on (`boostSupported` / `boostRequested`).
 *
 * This file exists because nothing tested that wiring. The specs that looked
 * like end-to-end boost coverage (`planDevices.test.ts`) build their input
 * through `fixtureBoostInput` in `test/utils/planTestUtils.ts`, which is a
 * SECOND implementation of the same wiring: it re-derives `commandableNow`,
 * re-picks the profile and re-passes the configs. Those assertions therefore
 * pass by construction of the fixture, not by the producer's behaviour, and
 * three separate miswires here would compile with every suite green — dropping
 * the `currentTemperature` spread, passing the retry-PROJECTED `commandableNow`
 * instead of the physical one, or resolving against the confirmed profile
 * instead of the planner's. Each is pinned below, off real `toPlanDevice`
 * output.
 *
 * The resolver contract itself lives in `test/unit/boostResolution.test.ts`;
 * the planner's half (runnable gate, draw release, forced request) in
 * `test/unit/planBoost.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type {
  DecoratedDeviceSnapshot,
  SteppedLoadProfile,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';

const FIXED_NOW = new Date('2026-08-16T12:00:00Z').getTime();

const LADDER: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const buildHeater = (
  overrides: Partial<DecoratedDeviceSnapshot> = {},
): DecoratedDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Hoiax',
  available: true,
  deviceClass: 'heater',
  controlModel: 'stepped_load',
  steppedLoadProfile: LADDER,
  // `resolveSteppedClusterFields` refuses the cluster without a named step, and
  // no cluster means no ladder means no boost — so a fixture that omits this
  // would assert nothing about boost at all.
  selectedStepId: 'low',
  binaryControl: { on: true },
  targets: [{ id: 'target_temperature', value: 70, unit: '°C', min: 30, max: 85, step: 1 }],
  temperature: {
    currentTemperature: 48,
    target: { id: 'target_temperature', value: 70, unit: '°C', min: 30, max: 85, step: 1 },
  },
  ...overrides,
}) as DecoratedDeviceSnapshot;

const ctxWith = (
  temperatureBoost: TemperatureBoostConfig | undefined,
  extra: Partial<AppContext> = {},
): AppContext => {
  const ctx = createAppContextMock();
  const loose = ctx as unknown as Record<string, unknown>;
  loose.getNow = () => new Date(FIXED_NOW);
  loose.getTemperatureBoostConfig = () => temperatureBoost;
  Object.assign(loose, extra);
  return ctx;
};

describe('toPlanDevice — boost producer wiring', () => {
  it('requests boost from the device own reading and configured floor', () => {
    // The whole chain through the real producer: ladder → drivable → enabled
    // config → live temperature below the floor. Dropping the
    // `currentTemperature` spread in `resolvePlanBoostFields` breaks only this.
    const device = toPlanDevice(
      ctxWith({ enabled: true, boostBelowC: 55 }),
      buildHeater(),
    );
    expect(device.boostSupported).toBe(true);
    expect(device.boostRequested).toBe(true);
  });

  it('does not request once the reading is at or above the floor', () => {
    const device = toPlanDevice(
      ctxWith({ enabled: true, boostBelowC: 55 }),
      buildHeater({
        temperature: {
          currentTemperature: 61,
          target: { id: 'target_temperature', value: 70, unit: '°C', min: 30, max: 85, step: 1 },
        },
      } as Partial<DecoratedDeviceSnapshot>),
    );
    expect(device.boostSupported).toBe(true);
    expect(device.boostRequested).toBe(false);
  });

  it('supports boost on a drivable ladder with no boost config at all', () => {
    // What the smart-task rescue lane needs: `forceBoostActive` is gated on
    // `boostSupported`, which must not depend on the owner having configured a
    // threshold, or on the device exposing a temperature target.
    const device = toPlanDevice(
      ctxWith(undefined),
      buildHeater({ targets: [] }),
    );
    expect(device.boostSupported).toBe(true);
    expect(device.boostRequested).toBe(false);
  });

  it('withholds boost entirely from a device with no step ladder', () => {
    const device = toPlanDevice(
      ctxWith({ enabled: true, boostBelowC: 55 }),
      buildHeater({ steppedLoadProfile: undefined, controlModel: 'binary_power' }),
    );
    expect(device.boostSupported).toBe(false);
    expect(device.boostRequested).toBe(false);
  });

  it('withholds boost from a device Homey reports unavailable', () => {
    // `commandableNow` folds availability, and boost reads it, so an
    // unreachable device is not boost-supported however cold it is.
    const device = toPlanDevice(
      ctxWith({ enabled: true, boostBelowC: 55 }),
      buildHeater({ available: false }),
    );
    expect(device.boostSupported).toBe(false);
    expect(device.boostRequested).toBe(false);
  });

  it('withholds boost when the owner switched setpoint control off', () => {
    // `resolveEffectiveTemperatureBoost` refuses the config for a device whose
    // temperature control the owner disabled, so the runtime cannot boost on a
    // setpoint it is not allowed to move.
    const device = toPlanDevice(
      ctxWith({ enabled: true, boostBelowC: 55 }),
      buildHeater({ temperatureControlDisabled: true } as Partial<DecoratedDeviceSnapshot>),
    );
    expect(device.boostRequested).toBe(false);
  });
});
