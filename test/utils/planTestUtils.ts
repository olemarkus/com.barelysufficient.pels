import type {
  DevicePlan,
  DevicePlanDevice,
  PlanInputDevice,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
  TemperatureKind,
  SteppedPlanDevice,
} from '../../lib/plan/planTypes';
import { type ShedBehavior, withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import type {
  DecoratedDeviceSnapshot,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  EvChargingState,
  MeasuredPowerObservedProbe,
  RestorePowerSource,
  TemperatureObservation,
  TemperatureObservedProbe,
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
import { getSteppedLoadLowestActiveStep } from '../../lib/utils/deviceControlProfiles';
import {
  TARGET_TEMPERATURE_CAPABILITY_ID,
  resolveTemperatureObservation,
} from '../../lib/device/transport/temperatureObservation';
import {
  buildResidualKwForPlanDevice,
  resolveResidualShedBehavior,
} from '../../setup/appInit/residualKwForPlanDevice';
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
 * The targets list production would have had for this fixture's temperature
 * intent.
 *
 * A fixture spells the setpoint flat (`currentTarget`), where production reads a
 * `target_temperature` capability entry — so synthesize that entry from what the
 * fixture actually said. It is a translation, not an invention: a device with a
 * setpoint has the capability that carries it. A fixture that spelled its own
 * `target_temperature` entry keeps it verbatim, min/max/step included, and its
 * value wins — the entry is what production's own admission and the shed math
 * both read, so the two cannot end up on different numbers.
 *
 * No setpoint anywhere means no entry, and therefore no facet.
 */
const fixtureTemperatureTargets = (device: {
  currentTarget?: number;
  plannedTarget?: number;
  targets?: TargetCapabilitySnapshot[];
}): TargetCapabilitySnapshot[] => {
  const spelled = device.targets ?? [];
  if (spelled.some((target) => target.id === TARGET_TEMPERATURE_CAPABILITY_ID)) return spelled;
  // `plannedTarget` counts, `currentTemperature` does not, and the difference is
  // which capability the fixture claimed. Both a current and a planned setpoint
  // are statements ABOUT a setpoint, so either is evidence the device has one —
  // a fixture that states only where it is heading describes a device sitting at
  // that setpoint, which is the behaviour-neutral reading the cluster has always
  // taken. A bare sensor reading claims `measure_temperature` and says nothing
  // about a setpoint capability; inventing one there is the same fabrication in
  // the other direction, and it would let a fixture pin a zero shed residual on
  // a device production frees whole.
  const setpoint = device.currentTarget ?? device.plannedTarget;
  if (setpoint === undefined) return spelled;
  return [...spelled, { id: TARGET_TEMPERATURE_CAPABILITY_ID, value: setpoint, unit: '°C' }];
};

/**
 * The observed temperature FACET a fixture's own signals imply — admitted by
 * PRODUCTION'S OWN resolver, never restated here.
 *
 * The producer's shed-behaviour projection denies a `set_temperature` shed when
 * the device carries no observed temperature, and this facet is what it reads.
 * `resolveTemperatureObservation` admits one only with ALL THREE of a
 * `target_temperature` entry, a defined sensor reading, and a finite target
 * value; anything less is `undefined`, and `resolveResidualShedBehavior` falls
 * back to `turn_off`.
 *
 * `currentTemperature` is therefore whatever the fixture SAID and nothing else.
 * Defaulting it to the setpoint was the fabrication this helper used to commit:
 * it resolved `set_temperature` where production resolves `turn_off`, and for a
 * setpoint already at the shed temperature it stamped a ZERO shed residual on a
 * device whose whole draw production frees — a shape the producer cannot emit,
 * masking regressions in the missing-sensor planning path. A fixture that means
 * a device with a sensor says so.
 */
const fixtureTemperatureObservation = (device: {
  deviceType?: 'temperature' | 'onoff';
  currentTarget?: number;
  currentTemperature?: number;
  plannedTarget?: number;
  targets?: TargetCapabilitySnapshot[];
}): TemperatureObservation | undefined => {
  // An explicit `'onoff'` is the fixture denying the axis outright, the way
  // `temperatureControlDisabled` denies it in production. Without this, a
  // fixture could carry a facet while the plan device it lands on says `onoff`
  // — the half-cluster split this pairing exists to prevent, in reverse.
  if (device.deviceType === 'onoff') return undefined;
  return resolveTemperatureObservation({
    currentTemperature: device.currentTemperature,
    targets: fixtureTemperatureTargets(device),
  });
};

/**
 * The `targets` list a plan INPUT device carries, paired with the facet the same
 * way production pairs them. A fixture that spelled its own list and resolved no
 * facet keeps that list verbatim.
 */
const fixtureDeviceTargets = (device: {
  deviceType?: 'temperature' | 'onoff';
  currentTarget?: number;
  currentTemperature?: number;
  plannedTarget?: number;
  targets?: TargetCapabilitySnapshot[];
}): TargetCapabilitySnapshot[] => {
  const observation = fixtureTemperatureObservation(device);
  return observation ? [observation.target] : (device.targets ?? []);
};

/**
 * Stamp the plan device's temperature CLUSTER from the same facet the residual
 * resolution reads, and strip it — discriminant included — when there is none.
 *
 * The cluster and the facet are ONE decision, exactly as they are in production:
 * `resolveTemperatureInputFields` (`setup/appInit/toPlanDevice.ts`) derives
 * `deviceType`, `currentTarget` and `currentTemperature` from facet presence, so
 * "a snapshot claiming `'temperature'` without the facet plans as `'onoff'`,
 * never as a half-cluster". A fixture that resolved them separately could claim
 * temperature on the plan device while its residual resolution said onoff, which
 * is the split this pairing exists to prevent.
 *
 * `plannedTarget` is the one field with no production counterpart here — it is a
 * plan DECISION, not an observation — so a fixture that states none gets
 * "planned === current", i.e. no move. (`fixtureTemperatureTargets` does read it,
 * for a different question: whether the fixture claimed a setpoint capability at
 * all. Its value is only the "no move" default that already applies here.)
 */
const withFixtureTemperatureKind = <T extends {
  deviceType?: 'temperature' | 'onoff';
  targets?: TargetCapabilitySnapshot[];
}>(
  fields: T & TemperatureDiscriminantProbe,
):
| (Omit<T, keyof TemperatureDiscriminantProbe | 'deviceType'> & { deviceType?: 'onoff' })
| (Omit<T, keyof TemperatureDiscriminantProbe | 'deviceType'> & { deviceType: 'temperature' } & TemperatureKind) => {
  const observation = fixtureTemperatureObservation(fields);
  const {
    currentTarget: _ct, currentTemperature: _cte, plannedTarget: _pt, deviceType, ...rest
  } = fields;
  if (!observation) {
    return {
      ...rest,
      // Only a fixture that CLAIMED temperature is corrected; one that said
      // nothing keeps saying nothing, so an unrelated fixture does not acquire a
      // discriminant it never had.
      ...(deviceType !== undefined ? { deviceType: 'onoff' as const } : {}),
    };
  }
  return withTemperatureDiscriminant({
    ...rest,
    deviceType: 'temperature' as const,
    currentTarget: observation.target.value,
    currentTemperature: observation.currentTemperature,
    plannedTarget: fields.plannedTarget ?? observation.target.value,
    // The regrouper's return type is a union because it re-reads `deviceType` at
    // runtime; this call always passes `'temperature'`, so the non-temperature
    // member is unreachable and the cast just says so.
  }) as Omit<T, keyof TemperatureDiscriminantProbe | 'deviceType'>
  & { deviceType: 'temperature' } & TemperatureKind;
};

/**
 * Resolve a fixture's readable `evChargingState: 'plugged_out'` input into the
 * flat producer-resolved bits — `commandableNow`, `commandabilityReason`,
 * `objectiveSessionInactive` — and then STRIP the raw field, exactly as
 * `toPlanDevice` does.
 *
 * Stripping is the point, not a side effect: the plan device does not carry
 * `evChargingState` (owner ruling 2026-08-15, `lib/plan/AGENTS.md`), so a fixture
 * that kept it would be a plan-shaped device carrying a plug state production
 * removed — a second answer to a question the flat bits already settle. Plan
 * consumers read no plug-state at all; the executor drift path reads
 * `commandableNow`, and the settings UI sources the state itself from the
 * observer via `getObservedEvChargingState`.
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
): Omit<T, 'evChargingState'> & {
  commandableNow: boolean;
  boostSupported: boolean;
  boostRequested: boolean;
  hasStandingDemand: boolean;
  confirmedNotDrawing: boolean;
  objectiveKind?: 'ev_soc';
  objectiveSessionInactive: boolean;
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
  // Mirror the producer EXACTLY: `toPlanDevice` resolves the plug-state into the
  // flat bits below and strips the raw field. A fixture that kept it made the
  // dead `device.evChargingState` reads in the objectives layer look alive for
  // months — every test passed while production never entered the branch.
  const { evChargingState: _rawPlugState, ...withoutPlugState } = overrides as typeof overrides & {
    evChargingState?: string;
  };
  return {
    ...(withoutPlugState as Omit<T, 'evChargingState'>),
    commandableNow: explicitCommandableNow ?? resolveCommandableNow(dev),
    boostSupported: explicitBoost.boostSupported ?? resolveBoostSupported(boostInput),
    boostRequested: explicitBoost.boostRequested ?? resolveBoostRequested(boostInput),
    // Mirrors the producer: everything but a charger is going without when it is
    // off. A fixture may still say otherwise explicitly.
    hasStandingDemand: (overrides as { hasStandingDemand?: boolean }).hasStandingDemand ?? !isEv,
    surplusTracking: (overrides as { surplusTracking?: boolean }).surplusTracking ?? false,
    // Required two-state producer bit; `false` is "no calibration opinion".
    confirmedNotDrawing: (overrides as { confirmedNotDrawing?: boolean }).confirmedNotDrawing ?? false,
    ...(isEv ? { objectiveKind: 'ev_soc' as const } : {}),
    // Mirrors `resolvePlanObjective`: the session question, resolved from the
    // plug-state before the producer strips it. Never `commandableNow`.
    objectiveSessionInactive: isEv
      && (overrides.evChargingState === 'plugged_out'
        || overrides.evChargingState === 'plugged_in_discharging'),
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
  //
  // DELEGATED to the production helper rather than restated: the hand-rolled
  // `steps.find(planningPowerW > 0)` this replaced read DECLARATION order,
  // while `getSteppedLoadLowestActiveStep` sorts by power first. Every shared
  // fixture ladder happens to be declared in ascending order, so the two agreed
  // — a restated mirror that is right by coincidence is exactly the thing this
  // file exists to stop.
  const lowestActiveStepId = getSteppedLoadLowestActiveStep(probe.steppedLoadProfile)?.id;
  if (lowestActiveStepId === undefined) return fields;
  const selectedStepId = probe.selectedStepId ?? lowestActiveStepId;
  const step = probe.steppedLoadProfile.steps.find((candidate) => candidate.id === selectedStepId);
  return {
    ...fields,
    selectedStepId,
    planningPowerKw: probe.planningPowerKw ?? (step ? step.planningPowerW / 1000 : 0),
  } as T;
};

/**
 * A fixture's binary axis, resolved the way the shared builders stamp it.
 *
 * The producer asks one question of the snapshot — `binaryControl !== undefined`
 * — and both builders answer it the same way: every fixture gets a binary axis
 * unless it says otherwise, either by `binaryControllable: false` or by spelling
 * `binaryCapabilityId: undefined` with no other binary signal. Shared so the
 * residual resolution below asks it of the axis the builder will actually stamp,
 * rather than of the raw override bag (where the default is still implicit).
 */
const fixtureBinaryAxisDisabled = (overrides: object): boolean => {
  const o = overrides as {
    binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    currentOn?: boolean;
  };
  return o.binaryControllable === false
    || (Object.prototype.hasOwnProperty.call(overrides, 'binaryCapabilityId')
      && o.binaryCapabilityId === undefined
      && o.binaryControl === undefined
      && o.currentOn === undefined);
};

/**
 * The owner-CONFIGURED shed behaviour a fixture may spell, so its residual is the
 * one the producer would have stamped. It is the settings-store value, not the
 * projection onto the device — `resolveResidualShedBehavior` performs that, and
 * the fixture calls it rather than restating either arm. Named for fixtures
 * because specs with their own local device builder accept it on their override
 * bag too.
 *
 * `getShedBehavior` answers `turn_off` for a device the owner never configured,
 * which is every fixture that does not spell one, so absence resolves to the
 * same thing the producer would have read. A spec whose plan deps configure a
 * different behaviour spells the SAME value here; the field is consumed by the
 * residual resolution and never lands on the device.
 */
export type FixtureShedBehavior = ShedBehavior;

export type FixtureResidualKw = {
  shed: number;
  restore: { kw: number; source: RestorePowerSource };
};

/**
 * Resolve a fixture's `residualKw` through the PRODUCER ITSELF —
 * `buildResidualKwForPlanDevice`, the function `toPlanDevice` calls — so a
 * fixture cannot carry a residual production would never stamp.
 *
 * This used to be a hand-rolled mirror of the producer's two adapters
 * (`toResidualSteppedLoad` / `toResidualTemperatureTarget`), and it had drifted
 * three ways: it read `hasKnownEffectiveStep` as `selectedStepId !== undefined`
 * (ignoring reported/target/desired/restore-prepared step evidence), it keyed
 * the temperature target on `id === 'target_temperature'` instead of the primary
 * target capability and dropped its `min`/`max`/`step`, and it resolved only the
 * `shed` half — leaving `restore` absent, which is a shape the producer cannot
 * emit and which kept a dead fallback alive in `lib/plan/restore/accounting.ts`.
 * Delegating removes all three at once, and removes the class.
 *
 * Exported because several specs keep their own local device builder; they must
 * not re-derive this by hand.
 */
export const fixtureResidualKw = (
  device: Record<string, unknown> & {
    currentDrawKw?: number;
    expectedPowerKw?: number;
    deviceClass?: string;
    deviceRole?: 'ev_charger';
    binaryCapabilityId?: string;
    binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    currentOn?: boolean;
    currentState?: string;
    steppedLoadProfile?: SteppedLoadProfile;
    selectedStepId?: string;
    shedBehavior?: FixtureShedBehavior;
    deviceType?: 'temperature' | 'onoff';
    currentTarget?: number;
    currentTemperature?: number;
    plannedTarget?: number;
    targets?: TargetCapabilitySnapshot[];
  },
): FixtureResidualKw => {
  const currentDrawKw = fixtureCurrentDrawKw(device);
  const temperature = fixtureTemperatureObservation(device);
  // Every field this function resolves ON the fixture's behalf, name- and
  // type-checked against the snapshot the producer expects. The outer cast below
  // is the fixture-constructor boundary and would hide a typo here; `satisfies`
  // is what keeps it honest, because a misspelled field would otherwise reach
  // the producer as `undefined` and yield a wrong-but-plausible residual.
  const producerFields = {
    // The RAW binary axis the producer reads, resolved from whichever signal the
    // fixture spells — the same resolution `resolveFixtureCurrentState` performs.
    // The producer's restore adapter re-derives `currentState` from this axis
    // (`resolveObservedCurrentState`), so a fixture that expresses "off at a
    // higher step" only as the four-valued LABEL must hand the adapter the axis
    // that label came from, or the adapter reads the device as on.
    binaryControl: fixtureBinaryAxisDisabled(device)
      ? undefined
      : { on: resolveFixtureCurrentOn(device) },
    // The producer reads the RAW meter field and resolves `currentDrawKw` from
    // it once; a fixture states the resolved figure, so hand it back at the seam
    // the producer reads it from. `normalizeMeasuredPowerKw` round-trips every
    // finite non-negative kW, so this is the identity for any draw a producer
    // could have resolved.
    measuredPowerKw: currentDrawKw,
    // Required by the restore ladder (`getHighestKnownPowerKw`), and resolved by
    // the same fixture rung the builders stamp so a fixture that describes no
    // power still gets the producer's own evidence-free answer.
    expectedPowerKw: fixtureExpectedPowerKw(device),
    // The atomic observed facet the shed-behaviour projection reads; fixtures
    // spell the same fact flat.
    temperature,
    // Production's transport emits the pair as ONE line
    // (`managerParseDeviceFields.ts`): `targets = temperature ? [temperature.target] : []`.
    // It matters here because the shed math reads the setpoint off `targets`
    // (`toResidualTemperatureTarget`) and the denial gate reads it off the facet:
    // a list that outlives its facet lets a sensorless fixture compare setpoints
    // production would never have compared, and a list the facet was not built
    // from lets the two read different numbers.
    targets: temperature ? [temperature.target] : [],
  } satisfies Partial<
  DecoratedDeviceSnapshot & MeasuredPowerObservedProbe & TemperatureObservedProbe
  >;
  const snapshot = withFixtureSteppedTriple({
    ...device,
    ...producerFields,
  }) as unknown as DecoratedDeviceSnapshot & MeasuredPowerObservedProbe
    & TemperatureObservedProbe;
  return buildResidualKwForPlanDevice({
    device: snapshot,
    // The exact question the producer asks of the snapshot it was handed.
    hasBinaryControl: snapshot.binaryControl !== undefined,
    // Projected by the production function, not restated here: an earlier
    // hand-rolled mirror of it kept the `set_step` arm and silently dropped the
    // `set_temperature` denial, which is the shape this whole change removes.
    shedBehavior: resolveResidualShedBehavior(
      device.shedBehavior ?? { action: 'turn_off' },
      snapshot,
    ),
  });
};

/**
 * Stamp the producer-resolved `residualKw` onto a fixture's own field bag.
 *
 * The wrapper form is for the many specs that build a plan device as a bare
 * object literal rather than through `buildPlanInputDevice`: it reads the same
 * fields the producer reads, so those fixtures get BOTH halves without restating
 * either. A declared half still wins — that is how a spec whose subject IS one of
 * the two figures pins it — while the other half is still producer-resolved.
 *
 * Wrapping a bag that has ALREADY been through a builder is the one shape to be
 * careful with: the builder destructures the raw binary signals away, so "no
 * binary axis" survives only as the absence of `currentOn`, which reads here as
 * "unstated" rather than "absent". Such a bag must spell `binaryControllable:
 * false` for itself. Do not try to infer it — a bag spelling `currentState` and
 * no binary signal is indistinguishable from a raw override that means the
 * builder's default.
 */
/**
 * Also stamps a default `priority`: it is REQUIRED on both plan device types
 * because the producer ranks the whole planned set before any consumer sees it,
 * and a hand-rolled fixture that does not care about ordering still has to
 * carry one. Declared values win.
 */
export const withFixtureResidualKw = <T extends object>(
  fields: T,
): T & { residualKw: FixtureResidualKw; priority: number } => {
  const priority = (fields as { priority?: number }).priority ?? 1;
  const declared = (fields as { residualKw?: Partial<FixtureResidualKw> }).residualKw;
  // A fully declared residual is taken verbatim and nothing is resolved. That is
  // the only way to express the one shape the producer cannot be handed at all:
  // a deliberately malformed ladder, built to prove the executor survives a
  // projection failure. Asking the producer to read it would throw, and
  // production resolves the residual long before such a ladder reaches a plan.
  if (declared?.shed !== undefined && declared.restore !== undefined) {
    return { ...fields, priority, residualKw: { shed: declared.shed, restore: declared.restore } };
  }
  const resolved = fixtureResidualKw(fields as Parameters<typeof fixtureResidualKw>[0]);
  return {
    ...fields,
    priority,
    residualKw: {
      shed: declared?.shed ?? resolved.shed,
      restore: declared?.restore ?? resolved.restore,
    },
  };
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
    // An observation, not plan state: it reaches the fixture through the snapshot
    // spread in `toPlanDevice`, and the settings UI reads the real thing via
    // `getObservedStateOfCharge`. There is no EV cluster on the plan types.
    stateOfCharge?: DeviceStateOfChargeSnapshot;
    /** Legacy fixture alias for `currentDrawKw` (see `fixtureCurrentDrawKw`). */
    measuredPowerKw?: number;
    /**
     * The shed behaviour the owner configured for this device. CONSUMED by the
     * residual resolution and never stamped — a plan device carries the residual,
     * not the behaviour behind it. Spell it when the spec's plan deps configure
     * something other than `turn_off`; see `FixtureShedBehavior`.
     */
    shedBehavior?: FixtureShedBehavior;
  } = {},
):
DevicePlanDevice => {
  const {
    reason, currentTarget, currentTemperature,
    binaryControllable: _binaryControllable,
    binaryCapabilityId: _binaryCapabilityId,
    shedBehavior: _shedBehavior,
    measuredPowerKw: _measuredPowerKw, currentDrawKw: _currentDrawKw, ...rest
  } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    binaryControllable?: boolean;
    binaryCapabilityId?: string;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const binaryExplicitlyDisabled = fixtureBinaryAxisDisabled(overrides);
  const currentOn = resolveFixtureCurrentOn(o);
  return {
    id: 'dev',
    name: 'Device',
    // Producer-resolved label (an explicit override in `...rest` still wins below).
    currentState: resolveFixtureCurrentState({ ...o, binaryControllable: !binaryExplicitlyDisabled }),
    plannedState: 'keep',
    // Finalize-stamped in production; fixture default mirrors pre-finalize.
    recordRestoreOnTargetApply: false,
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
    // One rule for a declared residual, shared with every bare-literal fixture:
    // `withFixtureResidualKw` decides what a declaration overrides and what the
    // producer still resolves.
    residualKw: withFixtureResidualKw(overrides).residualKw,
    // Stamped AFTER the caller spread, like `currentDrawKw`: an explicit
    // `expectedPowerKw: undefined` in a fixture must not ship a required field
    // as missing, which would propagate as NaN through every restore
    // reservation and headroom sum.
    expectedPowerKw: fixtureExpectedPowerKw(overrides),
    // Same treatment, same reason: `priority` is REQUIRED on both plan device
    // types because the producer ranks the whole planned set before anyone sees
    // it. A fixture that does not care about ordering still needs a rank, and
    // `1` is the only one a single-device spec could mean.
    priority: overrides.priority ?? 1,
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
    surplusTracking: overrides.surplusTracking ?? false,
    // Mirrors production's ONE stamp site (`finalizePlanDevices`), through the
    // same resolver: the plan's shed END STATE, derived from the device's final
    // `plannedState` + shed triple. Without it every fixture would reach the
    // executor as "not shed" — a decision, not a gap. An explicit override still
    // wins, so a test can pin a deliberately inconsistent device.
    plannedShedTargetKind: overrides.plannedShedTargetKind
      ?? resolvePlannedShedTargetKind({
        plannedState: overrides.plannedState ?? 'keep',
        shedAction: overrides.shedAction,
        steppedLoadProfile: (overrides as SteppedDiscriminantProbe).steppedLoadProfile,
        plannedShedStepId: overrides.plannedShedStepId,
      }),
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
    /**
     * The shed behaviour the owner configured for this device. CONSUMED by the
     * residual resolution and never stamped — a plan device carries the residual,
     * not the behaviour behind it. Spell it when the spec's plan deps configure
     * something other than `turn_off`; see `FixtureShedBehavior`.
     */
    shedBehavior?: FixtureShedBehavior;
  } = {},
): PlanInputDevice => {
  const {
    available, controllable, currentTarget, currentTemperature,
    binaryControllable: _binaryControllable,
    binaryCapabilityId: _binaryCapabilityId,
    shedBehavior: _shedBehavior,
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
  const binaryExplicitlyDisabled = fixtureBinaryAxisDisabled(overrides);
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
    // The setpoint capability the facet was admitted from. Production co-emits
    // the two (`managerParseDeviceFields`: `targets = temperature ? [temperature.target] : []`),
    // and the planner's own shed-candidate selection reads the LIST, not the
    // cluster (`candidates.ts` keys `set_temperature` on `device.targets?.[0]`) —
    // so a fixture with a temperature cluster and an empty list would take the
    // binary candidate while its residual was resolved on the setpoint arm.
    targets: fixtureDeviceTargets(overrides),
    // Required since the dual-read collapse: the producer always stamps a
    // residual, so a fixture without one is a shape production never emits and
    // `resolveRemainingSheddableLoadKw` would dereference `undefined`. Resolved
    // through the SAME function the producer uses, never defaulted to the draw
    // — a stepped fixture already at its off step must still resolve to 0.
    // One rule for a declared residual, shared with every bare-literal fixture:
    // `withFixtureResidualKw` decides what a declaration overrides and what the
    // producer still resolves.
    residualKw: withFixtureResidualKw(overrides).residualKw,
    // Stamped AFTER the caller spread, like `currentDrawKw`: an explicit
    // `expectedPowerKw: undefined` in a fixture must not ship a required field
    // as missing, which would propagate as NaN through every restore
    // reservation and headroom sum.
    expectedPowerKw: fixtureExpectedPowerKw(overrides),
    // Same treatment, same reason: `priority` is REQUIRED on both plan device
    // types because the producer ranks the whole planned set before anyone sees
    // it. A fixture that does not care about ordering still needs a rank, and
    // `1` is the only one a single-device spec could mean.
    priority: overrides.priority ?? 1,
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
    surplusTracking: overrides.surplusTracking ?? false,
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
  powerIsMeasured: true,
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
