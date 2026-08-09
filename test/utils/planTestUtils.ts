import type {
  DevicePlanDevice,
  PlanInputDevice,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
  TemperatureKind,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type {
  DeviceStateOfChargeSnapshot, EvChargingState, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import { getCurrentDrawKw } from '../../lib/observer/observedPower';
import { estimatePower } from '../../lib/device/devicePowerEstimate';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';
import { fixtureDeviceReason } from './deviceReasonTestUtils.ts';

/**
 * Mirror the production producer: a binary fixture's `currentOn` is the resolved
 * on/off truth. Prefer an explicit override; then the structural resolution
 * (binary axis AND stepped-off fold via `resolveCurrentOn`) when the fixture
 * carries those signals; then the four-valued `currentState` label as a last
 * resort. Keeps fixtures' on/off truth consistent with the runtime stamping so
 * consumers reading `currentOn` behave identically to production.
 */
export const resolveFixtureCurrentOn = (device: {
  currentOn?: boolean;
  currentState?: string;
  binaryControl?: { on: boolean };
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
}): boolean => {
  if (typeof device.currentOn === 'boolean') return device.currentOn;
  // An EXPLICIT `currentState` is the production-consistent on/off label (it
  // already folds binary + step — e.g. "off at a higher step" sets `'off'` with
  // an active `selectedStepId`), so it wins over re-resolving from raw signals.
  if (device.currentState === 'off') return false;
  if (device.currentState === 'on') return true;
  if (device.binaryControl !== undefined || device.steppedLoadProfile !== undefined) {
    return resolveCurrentOn(device);
  }
  return true;
};

/**
 * Mirror the production producer (`toPlanDevice` → `resolveObservedCurrentState`):
 * the four-valued `currentState` label is resolved ONCE from the raw observed
 * signals and carried on the plan device, so plan consumers
 * (`planDevices.resolveCurrentState`, `planLiveStateMerge`) can trust it without
 * re-resolving from the raw binary axis. An explicit fixture `currentState` wins;
 * otherwise resolve from the binary axis (explicit `binaryControl`, else derived
 * from the resolved `currentOn` for a binary device) + the stepped profile +
 * staleness — the SAME resolver the runtime producer uses, so a fixture's label
 * matches what production would stamp for the same observed signals.
 */
export const resolveFixtureCurrentState = (device: {
  currentState?: string;
  currentOn?: boolean;
  binaryControl?: { on: boolean };
  controlCapabilityId?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
}): string => {
  if (typeof device.currentState === 'string') return device.currentState;
  const binaryControl = device.binaryControl
    ?? (device.controlCapabilityId !== undefined ? { on: resolveFixtureCurrentOn(device) } : undefined);
  return resolveObservedCurrentState({
    binaryControl,
    controlCapabilityId: device.controlCapabilityId as BinaryControlCapabilityId | undefined,
    steppedLoadProfile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
  });
};

/**
 * Treat a fixture's `currentTarget` / `currentTemperature` override as the
 * temperature-variant signal: a device carrying either is a temperature device,
 * so default `deviceType: 'temperature'` (unless the fixture set it explicitly)
 * and regroup the cluster onto `TemperatureKind`. Mirrors the production
 * producer, which always stamps `deviceType` from the snapshot. Without this,
 * the `isTemperaturePlanDevice` guard (which keys on `deviceType`) would read
 * `null` for fixtures that express temperature intent only through
 * `currentTarget`.
 */
const withFixtureTemperatureKind = <T extends { deviceType?: 'temperature' | 'onoff' }>(
  fields: T & TemperatureDiscriminantProbe,
):
| Omit<T, keyof TemperatureDiscriminantProbe>
| (Omit<T, keyof TemperatureDiscriminantProbe> & TemperatureKind) => {
  const hasTemperatureSignal = fields.currentTarget !== undefined
    || fields.currentTemperature !== undefined;
  if (!hasTemperatureSignal) {
    const {
      currentTarget: _ct, currentTemperature: _cte, plannedTarget: _pt, ...rest
    } = fields;
    return rest;
  }
  return withTemperatureDiscriminant({
    deviceType: 'temperature' as const,
    ...fields,
  });
};

/**
 * Test convenience: materialize the one producer-resolved bit
 * (`commandableNow`) from a fixture's readable `evChargingState: 'plugged_out'`
 * input, and KEEP the state itself — it is a planner field again, carried on the
 * EV cluster, and every plug-state question is answered from it.
 *
 * Mirrors the producer (`toPlanDevice`), so a fixture is faithful to a real
 * `PlanInputDevice`: the executor drift path reads `commandableNow` off it, and
 * plan consumers read the plug-state through `isEvPlanDevice`.
 *
 * `commandableNow` is materialized for EVERY fixture, EV or not, because it is a
 * required base field — a fixture without it would let a consumer read
 * `undefined` as "not commandable", the exact absence-as-answer bug the field's
 * requiredness exists to prevent.
 */
export const withMaterializedEvPlugState = <T extends { deviceClass?: string; controlCapabilityId?: string }>(
  overrides: T & { evChargingState?: string },
): T & { commandableNow: boolean } => {
  const dev = {
    ...overrides,
    evChargingState: overrides.evChargingState as EvChargingState | undefined,
  };
  return { ...overrides, commandableNow: resolveCommandableNow(dev) } as T & { commandableNow: boolean };
};

export const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};


/**
 * The draw a fixture device is presumed to be pulling, when the test did not say.
 *
 * DELEGATES to the production resolver, `getCurrentDrawKw`. That is the point: an
 * earlier version of this helper RESTATED the producer's rungs, and when
 * production lost one the fixture kept it — which is how 5,400 tests stayed green
 * over three real defects (unmetered devices unsheddable, the idle classifier
 * permanently silent, a standby trickle poisoning the learned rate). A fixture
 * that can drift from the producer will hide the next one too.
 *
 * A spec whose SUBJECT is the draw should pass `currentDrawKw` explicitly rather
 * than lean on this.
 */
export const fixtureCurrentDrawKw = (o: {
  currentDrawKw?: number;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  [key: string]: unknown;
}): number => (
  typeof o.currentDrawKw === 'number' ? o.currentDrawKw : getCurrentDrawKw(o)
);

const noopEstimateLogger = { structuredLog: { debug: () => {} } } as unknown as Logger;
const evidenceFreeEstimateByCapability = new Map<string, number>();

/**
 * The draw a fixture device is presumed to pull WHEN RUNNING, when the test did
 * not say.
 *
 * DELEGATES to the production ladder, `estimatePower`, for the same reason
 * `fixtureCurrentDrawKw` delegates to `getCurrentDrawKw`: a fixture that
 * restates the producer's rungs keeps them after production drops one, and that
 * is how 5,400 tests stayed green over three real defects. So this does not
 * hardcode 1 (or 1.38 for a charger) — it asks the producer what an
 * evidence-free device resolves to and uses the answer.
 *
 * A device with no `settings` and no `energyObj` lands on the ladder's last rung
 * by construction: `getLoadSettingWatts` and `getHomeyEnergyEstimateWatts` both
 * return `null`, and the override/peak stores are empty. Memoised per
 * `controlCapabilityId`, so the producer is asked twice per process rather than
 * once per fixture.
 *
 * A spec whose SUBJECT is the expected power should pass `expectedPowerKw`
 * explicitly rather than lean on this.
 */
export const fixtureExpectedPowerKw = (o: {
  expectedPowerKw?: number;
  controlCapabilityId?: BinaryControlCapabilityId;
}): number => {
  if (typeof o.expectedPowerKw === 'number') return o.expectedPowerKw;
  const key = o.controlCapabilityId ?? '';
  const memoised = evidenceFreeEstimateByCapability.get(key);
  if (memoised !== undefined) return memoised;
  const resolved = estimatePower({
    device: { id: 'fixture', name: 'fixture' } as HomeyDeviceLike,
    deviceId: 'fixture',
    deviceLabel: 'fixture',
    controlCapabilityId: o.controlCapabilityId,
    now: 0,
    state: {
      expectedPowerKwOverrides: {},
      lastKnownPowerKw: {},
      lastEstimateDecisionLogByDevice: new Map(),
      lastPeakPowerLogByDevice: new Map(),
    },
    logger: noopEstimateLogger,
  }).expectedPowerKw;
  evidenceFreeEstimateByCapability.set(key, resolved);
  return resolved;
};

export const buildPlanDevice = (
  // `currentOn`/`binaryControl` live on the orthogonal `BinaryControlKind` cluster
  // (not on the `Partial<DevicePlanDevice>` base), so accept them here: the builder
  // resolves the producer-owned `currentOn`/`currentState` from whichever the
  // fixture supplies (mirroring `toPlanDevice`).
  overrides: Partial<DevicePlanDevice> & TemperatureDiscriminantProbe & {
    reason?: DevicePlanDevice['reason'] | string;
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
    currentOn?: boolean;
    binaryControl?: { on: boolean };
    // Lives on the orthogonal `EvKind` cluster, same as the two above; the plan
    // device receives it through the snapshot spread in `toPlanDevice`.
    stateOfCharge?: DeviceStateOfChargeSnapshot;
    /** Legacy fixture alias for `currentDrawKw` (see `fixtureCurrentDrawKw`). */
    measuredPowerKw?: number;
  } = {},
):
DevicePlanDevice => {
  const {
    reason, currentTarget, currentTemperature,
    measuredPowerKw: _measuredPowerKw, currentDrawKw: _currentDrawKw, ...rest
  } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    controlCapabilityId?: BinaryControlCapabilityId;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const currentOn = resolveFixtureCurrentOn(o);
  return {
    id: 'dev',
    name: 'Device',
    // Producer-resolved label (an explicit override in `...rest` still wins below).
    currentState: resolveFixtureCurrentState({ ...o, controlCapabilityId: o.controlCapabilityId ?? 'onoff' }),
    plannedState: 'keep',
    controlCapabilityId: 'onoff',
    reason: fixtureDeviceReason('keep')!,
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTarget !== undefined ? { currentTarget } : {}),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
    // Spread (not a direct property) so the `as DevicePlanDevice` cast accepts it:
    // `currentOn` lives on the orthogonal `BinaryControlKind`, reached via the guard.
    ...({ currentOn }),
    // AFTER the caller spread, and destructured out of `rest` above: a required
    // field must not be settable to `undefined` by an explicit override.
    currentDrawKw: fixtureCurrentDrawKw(overrides),
    // Stamped AFTER the caller spread, like `currentDrawKw`: an explicit
    // `expectedPowerKw: undefined` in a fixture must not ship a required field
    // as missing, which would propagate as NaN through every restore
    // reservation and headroom sum.
    expectedPowerKw: fixtureExpectedPowerKw(overrides),
    // Same treatment, same reason: the contract makes the source REQUIRED, and
    // this builder's cast is the one place that could still ship it absent.
    // `'default'` is what the producer emits for a device nothing is known
    // about — which is exactly the fixture `fixtureExpectedPowerKw` resolves.
    expectedPowerSource: overrides.expectedPowerSource ?? 'default',
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? fixtureDeviceReason(reason)! : reason }
      : {}),
  } as DevicePlanDevice;
};

export const buildPlanInputDevice = (
  // `currentOn`/`binaryControl` live on the orthogonal `BinaryPlanInputKind` cluster
  // (not on the `Partial<PlanInputDevice>` base), so accept them here: the builder
  // resolves the producer-owned `currentOn`/`currentState` from whichever the
  // fixture supplies (mirroring `toPlanDevice`).
  overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe & {
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
    currentOn?: boolean;
    binaryControl?: { on: boolean };
    /** Legacy fixture alias for `currentDrawKw` (see `fixtureCurrentDrawKw`). */
    measuredPowerKw?: number;
  } = {},
): PlanInputDevice => {
  const {
    currentTarget: _currentTarget, currentTemperature,
    measuredPowerKw: _measuredPowerKw, currentDrawKw: _currentDrawKw, ...rest
  } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    controlCapabilityId?: BinaryControlCapabilityId;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const currentOn = resolveFixtureCurrentOn({ ...o, binaryControl: o.binaryControl ?? { on: true } });
  // Producer-resolved label (an explicit override in `...rest` still wins below).
  const currentState = resolveFixtureCurrentState({
    ...o,
    binaryControl: o.binaryControl ?? { on: true },
    controlCapabilityId: o.controlCapabilityId ?? 'onoff',
  });
  return withBinaryDiscriminant({
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    controllable: true,
    controlCapabilityId: 'onoff',
    currentState,
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
    currentOn,
    // AFTER the caller spread, and destructured out of `rest` above: a required
    // field must not be settable to `undefined` by an explicit override.
    currentDrawKw: fixtureCurrentDrawKw(overrides),
    // Stamped AFTER the caller spread, like `currentDrawKw`: an explicit
    // `expectedPowerKw: undefined` in a fixture must not ship a required field
    // as missing, which would propagate as NaN through every restore
    // reservation and headroom sum.
    expectedPowerKw: fixtureExpectedPowerKw(overrides),
    // Same treatment, same reason: the contract makes the source REQUIRED, and
    // this builder's cast is the one place that could still ship it absent.
    // `'default'` is what the producer emits for a device nothing is known
    // about — which is exactly the fixture `fixtureExpectedPowerKw` resolves.
    expectedPowerSource: overrides.expectedPowerSource ?? 'default',
  }) as PlanInputDevice;
};

export const steppedPlanDevice = (
  overrides: Partial<DevicePlanDevice> & SteppedDiscriminantProbe
    & { binaryControl?: { on: boolean }; currentOn?: boolean } = {},
): DevicePlanDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanDevice({
    // `controlModel` is no longer a plan-device (output) field; the stepped
    // discriminant is the presence of a valid `steppedLoadProfile`.
    steppedLoadProfile: profile,
    selectedStepId,
    planningPowerKw: defaultPlanningKw,
    ...overrides,
  });
};

export const steppedInputDevice = (
  overrides: Partial<PlanInputDevice> & SteppedDiscriminantProbe
    & { evChargingState?: string; binaryControl?: { on: boolean }; currentOn?: boolean } = {},
): PlanInputDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile?.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanInputDevice({
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    selectedStepId,
    planningPowerKw: defaultPlanningKw,
    controlCapabilityId: 'onoff',
    targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
    ...overrides,
  });
};
