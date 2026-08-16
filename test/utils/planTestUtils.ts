import type {
  DevicePlan,
  DevicePlanDevice,
  PlanInputDevice,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
  TemperatureKind,
  SteppedPlanDevice,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type {
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  EvChargingState,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import type { SettingsUiPlanMetaSnapshot } from '../../packages/contracts/src/settingsUiApi';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { isEvDevice } from '../../packages/shared-domain/src/evPlugState';
import {
  type BoostResolveInput,
  resolveBoostRequested,
  resolveBoostSupported,
} from '../../lib/device/deviceActionProjection';
import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import { getCurrentDrawKw } from '../../lib/observer/observedPower';
import { estimatePower } from '../../lib/device/devicePowerEstimate';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { fixtureDeviceReason } from './deviceReasonTestUtils.ts';
import { fixtureResidualKw } from '../helpers/buildPlanInputDevice';

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
  binaryControllable?: boolean;
  binaryCapabilityId?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
}): string => {
  if (typeof device.currentState === 'string') return device.currentState;
  const binaryControl = device.binaryControl
    ?? (device.binaryControllable === true || device.binaryCapabilityId !== undefined || device.currentOn !== undefined
      ? { on: resolveFixtureCurrentOn(device) }
      : undefined);
  return resolveObservedCurrentState({
    binaryControl,
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
const FIXTURE_DEFAULT_TEMPERATURE_C = 21;

const withFixtureTemperatureKind = <T extends { deviceType?: 'temperature' | 'onoff' }>(
  fields: T & TemperatureDiscriminantProbe,
):
| Omit<T, keyof TemperatureDiscriminantProbe>
| (Omit<T, keyof TemperatureDiscriminantProbe> & TemperatureKind) => {
  const hasTemperatureSignal = fields.deviceType === 'temperature'
    || fields.currentTarget !== undefined
    || fields.currentTemperature !== undefined
    || fields.plannedTarget !== undefined;
  if (!hasTemperatureSignal) {
    const {
      currentTarget: _ct, currentTemperature: _cte, plannedTarget: _pt, ...rest
    } = fields;
    return rest;
  }
  // The temperature cluster is COMPLETE by producer invariant (atomic facet +
  // total planner resolution), so any temperature signal synthesizes the full
  // trio: a missing sensor reading defaults to "at setpoint" and a missing
  // planned target to "no decision" (planned === current) — both behavior-
  // neutral. Fixtures whose subject is one of these values set it explicitly.
  const currentTarget = fields.currentTarget
    ?? fields.plannedTarget
    ?? fields.currentTemperature
    ?? FIXTURE_DEFAULT_TEMPERATURE_C;
  return withTemperatureDiscriminant({
    deviceType: 'temperature' as const,
    ...fields,
    currentTarget,
    currentTemperature: fields.currentTemperature ?? currentTarget,
    plannedTarget: fields.plannedTarget ?? currentTarget,
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
 * requiredness exists to prevent. The two boost bits are materialized here for
 * the same reason and from the same producer resolvers the app calls, so a
 * fixture that spells a boost config and a reading gets the boost decision the
 * producer would have given it.
 */
export const withMaterializedEvPlugState = <T extends {
  deviceClass?: string; deviceRole?: 'ev_charger'; binaryCapabilityId?: string;
  available?: boolean;
}>(
  overrides: T & { evChargingState?: string },
): T & {
  commandableNow: boolean;
  boostSupported: boolean;
  boostRequested: boolean;
  hasStandingDemand: boolean;
  confirmedNotDrawing: boolean;
  objectiveKind?: 'ev_soc';
  objectiveSessionInactive?: boolean;
  commandabilityReason?: 'charger_unplugged' | 'charger_discharging';
} => {
  const explicitCommandableNow = (overrides as { commandableNow?: boolean }).commandableNow;
  const dev = {
    ...overrides,
    available: overrides.available ?? true,
    evChargingState: overrides.evChargingState as EvChargingState | undefined,
  };
  const isEv = overrides.deviceClass === 'evcharger'
    || overrides.deviceRole === 'ev_charger'
    || overrides.binaryCapabilityId === 'evcharger_charging';
  let commandabilityReason: 'charger_unplugged' | 'charger_discharging' | undefined;
  if (overrides.evChargingState === 'plugged_out') {
    commandabilityReason = 'charger_unplugged';
  } else if (overrides.evChargingState === 'plugged_in_discharging') {
    commandabilityReason = 'charger_discharging';
  }
  const boostInput = fixtureBoostInput(overrides as Parameters<typeof fixtureBoostInput>[0]);
  const explicitBoost = overrides as { boostSupported?: boolean; boostRequested?: boolean };
  return {
    ...overrides,
    commandableNow: explicitCommandableNow ?? resolveCommandableNow(dev),
    boostSupported: explicitBoost.boostSupported ?? resolveBoostSupported(boostInput),
    boostRequested: explicitBoost.boostRequested ?? resolveBoostRequested(boostInput),
    // Mirrors the producer: everything but a charger is going without when it is
    // off. A fixture may still say otherwise explicitly.
    hasStandingDemand: (overrides as { hasStandingDemand?: boolean }).hasStandingDemand ?? !isEv,
    // Required two-state producer bit; `false` is "no calibration opinion".
    confirmedNotDrawing: (overrides as { confirmedNotDrawing?: boolean }).confirmedNotDrawing ?? false,
    ...(isEv ? { objectiveKind: 'ev_soc' as const } : {}),
    ...(isEv ? {
      objectiveSessionInactive: overrides.evChargingState === 'plugged_out'
        || overrides.evChargingState === 'plugged_in_discharging',
    } : {}),
    ...(commandabilityReason ? { commandabilityReason } : {}),
  };
};

export const steppedProfile: SteppedLoadProfile = {
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
 * semantic device role, so the producer is asked twice per process rather than
 * once per fixture.
 *
 * A spec whose SUBJECT is the expected power should pass `expectedPowerKw`
 * explicitly rather than lean on this.
 */
export const fixtureExpectedPowerKw = (o: {
  expectedPowerKw?: number;
  deviceClass?: string;
  deviceRole?: 'ev_charger';
  binaryCapabilityId?: string;
}): number => {
  if (typeof o.expectedPowerKw === 'number') return o.expectedPowerKw;
  const isEv = o.deviceClass === 'evcharger'
    || o.deviceRole === 'ev_charger'
    || o.binaryCapabilityId === 'evcharger_charging';
  const key = isEv ? 'ev_charger' : 'generic';
  const memoised = evidenceFreeEstimateByCapability.get(key);
  if (memoised !== undefined) return memoised;
  const resolved = estimatePower({
    device: { id: 'fixture', name: 'fixture' } as HomeyDeviceLike,
    deviceId: 'fixture',
    deviceLabel: 'fixture',
    binaryCapabilityId: isEv ? 'evcharger_charging' : undefined,
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


// The stepped cluster is COMPLETE by producer invariant: any fixture supplying
// a ladder gets the missing halves synthesized (the effective step defaults to
// the lowest active step — the producer's own planning fallback — and the
// planning power to that step's rating), so the shared builders' casts can
// never stamp `undefined` behind the required `SteppedLoadKind`. Fixtures whose
// subject is a specific step set it explicitly.
const withFixtureSteppedTriple = <T extends object>(fields: T): T => {
  const probe = fields as {
    steppedLoadProfile?: SteppedLoadProfile;
    selectedStepId?: string;
    planningPowerKw?: number;
  };
  if (!probe.steppedLoadProfile) return fields;
  // Mirror the producer chain exactly: only a USABLE ladder (a rung above zero)
  // resolves a planning fallback, so a degenerate all-zero ladder — which
  // `asSteppedLoadProfile` refuses upstream — gets nothing synthesized here
  // either, and fixtures exercising that degenerate shape keep their meaning.
  const lowestActiveStepId = probe.steppedLoadProfile.steps.find((step) => step.planningPowerW > 0)?.id;
  if (lowestActiveStepId === undefined) return fields;
  const selectedStepId = probe.selectedStepId ?? lowestActiveStepId;
  const step = probe.steppedLoadProfile.steps.find((candidate) => candidate.id === selectedStepId);
  return {
    ...fields,
    selectedStepId,
    planningPowerKw: probe.planningPowerKw ?? (step ? step.planningPowerW / 1000 : 0),
  } as T;
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
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    deviceRole?: 'ev_charger';
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
    binaryControllable: _binaryControllable,
    binaryCapabilityId: _binaryCapabilityId,
    measuredPowerKw: _measuredPowerKw, currentDrawKw: _currentDrawKw, ...rest
  } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const binaryExplicitlyDisabled = o.binaryControllable === false
    || (Object.prototype.hasOwnProperty.call(overrides, 'binaryCapabilityId')
      && o.binaryCapabilityId === undefined
      && o.binaryControl === undefined
      && o.currentOn === undefined);
  const currentOn = resolveFixtureCurrentOn(o);
  return {
    id: 'dev',
    name: 'Device',
    // Producer-resolved label (an explicit override in `...rest` still wins below).
    currentState: resolveFixtureCurrentState({ ...o, binaryControllable: !binaryExplicitlyDisabled }),
    plannedState: 'keep',
    reason: fixtureDeviceReason('keep')!,
    ...withFixtureSteppedTriple(withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTarget !== undefined ? { currentTarget } : {}),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    })),
    // Spread (not a direct property) so the `as DevicePlanDevice` cast accepts it:
    // `currentOn` lives on the orthogonal `BinaryControlKind`, reached via the guard.
    ...(!binaryExplicitlyDisabled ? { currentOn } : {}),
    // AFTER the caller spread, and destructured out of `rest` above: a required
    // field must not be settable to `undefined` by an explicit override.
    currentDrawKw: fixtureCurrentDrawKw(overrides),
    // Required since the dual-read collapse: the producer always stamps a
    // residual, so a fixture without one is a shape production never emits and
    // `resolveRemainingSheddableLoadKw` would dereference `undefined`. Resolved
    // through the SAME function the producer uses, never defaulted to the draw
    // — a stepped fixture already at its off step must still resolve to 0.
    residualKw: overrides.residualKw
      ?? fixtureResidualKw({ ...overrides, currentDrawKw: fixtureCurrentDrawKw(overrides) }),
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
    // Same treatment again, for the same reason: both are REQUIRED on the plan
    // device because the producer resolves them for every device. A fixture
    // that says nothing represents the ordinary managed, reachable case, while
    // an explicit `false` still lands.
    controllable: overrides.controllable ?? true,
    available: overrides.available ?? true,
    // The plan device's one boost truth, REQUIRED for the same reason: the
    // planner resolves it for every device, so a fixture that omits it would let
    // a consumer read absence as "not boosting" — which is a decision, not a gap.
    boostActive: overrides.boostActive ?? false,
    hasStandingDemand: fixtureHasStandingDemand(overrides),
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? fixtureDeviceReason(reason)! : reason }
      : {}),
  } as DevicePlanDevice;
};

/**
 * The boost EVIDENCE a fixture may spell — a configured threshold, a battery
 * level. None of these are plan-device fields any more (a threshold is
 * configuration, a level is an observation); a fixture spells them so the
 * builder can resolve the producer's two boost bits from them, exactly as
 * `toPlanDevice` does from the settings seam and the observer. They are consumed
 * by the builder and never land on the device.
 */
/**
 * Mirror the producer's standing-demand resolution EXACTLY: `!isEvObserved`,
 * which is `deviceClass === 'evcharger'` and nothing else
 * (`packages/shared-domain/src/evPlugState.ts`). It used to also accept
 * `deviceRole` and `binaryCapabilityId` as charger evidence, which made the
 * fixture a superset of the producer — a fixture could express a starvation or
 * surplus posture `toPlanDevice` can never emit. A mirror that is broader than
 * what it mirrors is not a mirror.
 */
export const fixtureHasStandingDemand = (overrides: {
  hasStandingDemand?: boolean;
  deviceClass?: string;
}): boolean => overrides.hasStandingDemand ?? !isEvDevice(overrides);

export type FixtureBoostFields = {
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  temperatureBoost?: TemperatureBoostConfig;
};

// The producer's boost input, gathered from whatever the fixture spelled. Kept
// structural (not a `PlanInputDevice`) for the same reason the producer's own
// input is: the boost question is asked of a device's ladder and its own
// readings, before any plan shape exists. `commandableNow` is resolved from the
// fixture's plug state and availability exactly as `toPlanDevice` does.
const fixtureBoostInput = (overrides: FixtureBoostFields & {
  deviceClass?: string;
  available?: boolean;
  commandableNow?: boolean;
  targets?: TargetCapabilitySnapshot[];
  steppedLoadProfile?: SteppedLoadProfile;
  evChargingState?: string;
  currentTemperature?: number;
}): BoostResolveInput => ({
  // An explicit override wins, as it does for the device's own `commandableNow`
  // field. Without this a fixture that spells "not commandable" only as
  // `commandableNow: false` still resolved `boostSupported: true` — a state the
  // producer cannot emit, which is exactly what this mirror exists to prevent.
  commandableNow: overrides.commandableNow ?? resolveCommandableNow({
    deviceClass: overrides.deviceClass,
    available: overrides.available ?? true,
    evChargingState: overrides.evChargingState as EvChargingState | undefined,
  }),
  targets: overrides.targets ?? [],
  steppedLoadProfile: overrides.steppedLoadProfile,
  evBoost: overrides.evBoost,
  stateOfCharge: overrides.stateOfCharge,
  temperatureBoost: overrides.temperatureBoost,
  currentTemperature: overrides.currentTemperature,
});

export const buildPlanInputDevice = (
  // `currentOn`/`binaryControl` live on the orthogonal `BinaryPlanInputKind` cluster
  // (not on the `Partial<PlanInputDevice>` base), so accept them here: the builder
  // resolves the producer-owned `currentOn`/`currentState` from whichever the
  // fixture supplies (mirroring `toPlanDevice`).
  overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe & FixtureBoostFields & {
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
    currentOn?: boolean;
    binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    deviceRole?: 'ev_charger';
    /** Legacy fixture alias for `currentDrawKw` (see `fixtureCurrentDrawKw`). */
    measuredPowerKw?: number;
  } = {},
): PlanInputDevice => {
  const {
    available, controllable, currentTarget, currentTemperature,
    binaryControllable: _binaryControllable,
    binaryCapabilityId: _binaryCapabilityId,
    // Consumed by the boost resolution below and stripped here, the way the
    // producer strips them: a plan device carries the boost DECISION, never the
    // configuration or the reading behind it.
    evBoost: _evBoost, stateOfCharge: _stateOfCharge, temperatureBoost: _temperatureBoost,
    measuredPowerKw: _measuredPowerKw, currentDrawKw: _currentDrawKw, ...rest
  } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const binaryExplicitlyDisabled = o.binaryControllable === false
    || (Object.prototype.hasOwnProperty.call(overrides, 'binaryCapabilityId')
      && o.binaryCapabilityId === undefined
      && o.binaryControl === undefined
      && o.currentOn === undefined);
  const currentOn = resolveFixtureCurrentOn({ ...o, binaryControl: o.binaryControl ?? { on: true } });
  // Producer-resolved label (an explicit override in `...rest` still wins below).
  const currentState = resolveFixtureCurrentState({
    ...o,
    binaryControl: o.binaryControl ?? { on: true },
    binaryControllable: !binaryExplicitlyDisabled,
  });
  return withBinaryDiscriminant({
    id: 'dev',
    name: 'Device',
    targets: [],
    ...(!binaryExplicitlyDisabled ? { binaryControl: o.binaryControl ?? { on: true } } : {}),
    currentState,
    ...withFixtureSteppedTriple(withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTarget !== undefined ? { currentTarget } : {}),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    })),
    ...(!binaryExplicitlyDisabled ? { currentOn } : {}),
    // AFTER the caller spread, and destructured out of `rest` above: a required
    // field must not be settable to `undefined` by an explicit override.
    currentDrawKw: fixtureCurrentDrawKw(overrides),
    // Required since the dual-read collapse: the producer always stamps a
    // residual, so a fixture without one is a shape production never emits and
    // `resolveRemainingSheddableLoadKw` would dereference `undefined`. Resolved
    // through the SAME function the producer uses, never defaulted to the draw
    // — a stepped fixture already at its off step must still resolve to 0.
    residualKw: overrides.residualKw
      ?? fixtureResidualKw({ ...overrides, currentDrawKw: fixtureCurrentDrawKw(overrides) }),
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
    controllable: controllable ?? true,
    available: available ?? true,
    // The two producer-resolved boost bits, materialized from the fixture's own
    // config and readings by the SAME resolvers `toPlanDevice` calls, so a
    // fixture cannot express a boost state the producer would never emit. An
    // explicit override still wins — that is how a fixture pins the planner's
    // behaviour for a given pair without restating a charger's whole plug state.
    boostSupported: overrides.boostSupported ?? resolveBoostSupported(fixtureBoostInput(overrides)),
    boostRequested: overrides.boostRequested ?? resolveBoostRequested(fixtureBoostInput(overrides)),
    hasStandingDemand: fixtureHasStandingDemand(overrides),
    // Producer-required two-state bit. Default `false` — "the calibration store
    // has no opinion", which is what an unseeded fixture genuinely means and the
    // arm that leaves boost untouched.
    confirmedNotDrawing: overrides.confirmedNotDrawing ?? false,
  }) as PlanInputDevice;
};

export const steppedPlanDevice = (
  overrides: Partial<DevicePlanDevice> & SteppedDiscriminantProbe
    & { binaryControl?: { on: boolean }; currentOn?: boolean; binaryCapabilityId?: string } = {},
): SteppedPlanDevice => {
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
  }) as SteppedPlanDevice;
};

export const steppedInputDevice = (
  overrides: Partial<PlanInputDevice> & SteppedDiscriminantProbe & FixtureBoostFields
    & {
      evChargingState?: string;
      binaryControl?: { on: boolean };
      currentOn?: boolean;
      binaryCapabilityId?: string;
    } = {},
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
    binaryControllable: true,
    targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
    ...overrides,
  });
};

/**
 * A complete `DevicePlan['meta']`, so a fixture spells only what its assertion
 * is about.
 *
 * The plan meta is REQUIRED almost throughout — the planner writes every one of
 * these on every cycle, and saying so is what lets consumers stop hedging. That
 * is a good property for production and a bad one for fixtures, which had been
 * writing `{ totalKw, softLimitKw, headroomKw }` and relying on the other 20-odd
 * fields being optional. Rather than have ~33 specs each spell a full meta,
 * defaults live here and a spec overrides the two or three it cares about.
 *
 * The defaults describe an unremarkable on-track hour: 5 kW drawn against a
 * 6 kW pace under a 10 kW cap, capacity-bound, fresh sample, no daily budget.
 * A spec asserting on any of that should pass it explicitly rather than lean on
 * these numbers.
 */
export const buildPlanMeta = (
  overrides: Partial<DevicePlan['meta']> = {},
): DevicePlan['meta'] => {
  const meta = buildPlanMetaFields(overrides);
  // Mirror the producer's invariant so a fixture cannot encode a plan the
  // planner could never build: `splitControlledUsageKw` derives the background
  // side from the whole-home total, so it is absent exactly when the total is.
  // A spec that sets `totalKw: null` gets a null background side unless it
  // deliberately says otherwise.
  return meta.totalKw === null && overrides.uncontrolledKw === undefined
    ? { ...meta, uncontrolledKw: null }
    : meta;
};

const buildPlanMetaFields = (
  overrides: Partial<DevicePlan['meta']>,
): DevicePlan['meta'] => ({
  totalKw: 5,
  softLimitKw: 6,
  capacitySoftLimitKw: 6,
  dailySoftLimitKw: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  headroomKw: 1,
  powerNowKw: 5,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  capacityShortfall: false,
  shortfallBudgetHeadroomKw: null,
  hardCapLimitKw: 10,
  hardCapHeadroomKw: 5,
  hourlyBudgetExhausted: false,
  usedKWh: 1,
  budgetKWh: 6,
  capacityLimitKw: 10,
  minutesRemaining: 30,
  controlledKw: 2,
  uncontrolledKw: 3,
  dailyBudgetRemainingKWh: 0,
  dailyBudgetExceeded: false,
  ...overrides,
});

/**
 * The WIRE meta, complete. Distinct from {@link buildPlanMeta}: the settings-UI
 * snapshot is a PROJECTION of the planner's meta, not the same shape — it drops
 * the fields no consumer reads and adds `hourBudgetKWh`, which the read model
 * computes. A planner meta is therefore not assignable to it, and a fixture for
 * one is not a fixture for the other.
 */
export const buildSettingsUiPlanMeta = (
  overrides: Partial<SettingsUiPlanMetaSnapshot> = {},
): SettingsUiPlanMetaSnapshot => ({
  totalKw: 5,
  softLimitKw: 6,
  capacitySoftLimitKw: 6,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  headroomKw: 1,
  powerFreshnessState: 'fresh',
  hardCapLimitKw: 10,
  usedKWh: 1,
  hourBudgetKWh: 6,
  minutesRemaining: 30,
  controlledKw: 2,
  uncontrolledKw: 3,
  ...overrides,
});

/**
 * A build gate that is always open, for specs that are not exercising gating.
 *
 * `PlanServiceDeps.planBuildGate` is required: production wires
 * `PowerMeasurementGate`, and a spec that wants a plan built every cycle says so
 * here rather than by omitting the dep. Omission used to mean "open", which made
 * the unmeasured case — the one the gate exists to stop — the silent default.
 */
export const openPlanBuildGate = (): { isOpen: () => boolean } => ({ isOpen: () => true });
