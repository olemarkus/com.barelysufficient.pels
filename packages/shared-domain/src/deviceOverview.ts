import type {
  DeviceStateOfChargeSnapshot,
  EvChargingState,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../contracts/src/types.js';
import {
  buildComparableDeviceReason,
  type DeviceReason,
} from './planReasonSemantics';
import {
  isGrayStateDevice,
  isOffLikeState,
  isOnLikeState,
  normalizeDeviceState,
} from './deviceStatePredicates';
import { isSatisfiedTargetOnlyDevice, resolvePlanStateKind } from './planStateLabels';
import { formatStepDisplayLabel } from './steppedStepLabel';
import type { PlannedTemperatureState } from './plannedTemperatureState';
import { formatDeviceReasonUserFacingForDevice } from './planCardReasonLine';
import {
  DEVICE_OVERVIEW_ACTIVE,
  DEVICE_OVERVIEW_ACTIVE_CHARGING,
  DEVICE_OVERVIEW_ACTIVE_TEMPERATURE_MANAGED,
  DEVICE_OVERVIEW_CAPACITY_CONTROL_OFF,
  DEVICE_OVERVIEW_CHARGING_PAUSED,
  DEVICE_OVERVIEW_CHARGING_REQUESTED,
  DEVICE_OVERVIEW_IDLE,
  DEVICE_OVERVIEW_INACTIVE,
  DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING,
  DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED,
  DEVICE_OVERVIEW_INACTIVE_DISCHARGING,
  DEVICE_OVERVIEW_LIMITED,
  DEVICE_OVERVIEW_LOWERED,
  DEVICE_OVERVIEW_RESUME_REQUESTED,
  DEVICE_OVERVIEW_RESUMING,
  DEVICE_OVERVIEW_STATE_UNKNOWN,
  DEVICE_OVERVIEW_TURNED_OFF,
  DEVICE_OVERVIEW_UNAVAILABLE,
  DEVICE_OVERVIEW_UNKNOWN,
  DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER,
  deviceOverviewEvBatteryStatus,
  deviceOverviewLimitedToStep,
} from './deviceOverviewStrings';

/**
 * The stepped-control cluster, present IFF the device is stepped-controlled —
 * the overview shape's stepped discriminant, and the ONLY place a stepped fact
 * lives on this shape.
 *
 * It replaced a `controlModel: 'temperature_target' | 'binary_power' |
 * 'stepped_load'` setting that every consumer here only ever asked one question
 * of (`=== 'stepped_load'`), and that both carriers had to RECONSTRUCT because
 * the planner does not carry it — with different ladders, which is how the same
 * device came to render as a binary card on one surface and sign as stepped on
 * the other. `scripts/check-control-model-vocab.mjs` stated the rule: "stepped
 * load" is a yes/no CAPABILITY = presence of a valid ladder; `controlModel` is
 * a producer-only SETTING.
 *
 * The snapshot used to carry flat `reportedStepId` / `targetStepId` /
 * `selectedStepId` / `desiredStepId` / `steppedLoadProfile` BESIDE this,
 * copied raw off the plan device. That was not merely duplication: the two
 * disagreed. `buildOverviewSteppedLoad` corrects `targetStepId` when the
 * planner aims at a rung the confirmed ladder lacks (`plannerOnlyTarget`),
 * while the flat copy kept the uncorrected id — so the stepped card, which
 * reads this cluster, and `getSteppedModeTransitionText`, which read the flat
 * pair, answered differently for the same device.
 *
 * `selectedStepId` and `planningPowerKw` are REQUIRED here for the same reason
 * they are required on the planner's `SteppedLoadKind`: the producer chain
 * guarantees both for every stepped device (usable-ladder admission ⇒ a lowest
 * active step ⇒ an effective step and a planning power always resolve).
 */
export type DeviceOverviewSteppedLoad = {
  profile: SteppedLoadProfile;
  reportedStepId: string | null;
  targetStepId: string | null;
  /** Producer-resolved effective step. Required — see the docblock above. */
  selectedStepId: string;
  /** The draw the selected step is expected to pull. Required, as above. */
  planningPowerKw: number;
  commandPending: boolean;
};

export type DeviceOverviewSnapshot = {
  currentState?: string;
  plannedState?: string;
  /**
   * Present iff this device is stepped-controlled — the discriminant, and the
   * producer's own answer rather than a reconstruction. Absent means "no step
   * ladder", which is the only thing the retired `controlModel` was ever asked
   * here.
   */
  steppedLoad?: DeviceOverviewSteppedLoad;
  /**
   * NO `deviceType` here, deliberately. It used to ride this shape as the
   * temperature discriminant; the atomic `temperature` facet below replaced it,
   * because the facet is what actually carries the numbers a card renders. The
   * field then survived as a producer-only write with no reader on this shape —
   * a ghost the index-signature removal on `SettingsUiPlanDeviceSnapshot`
   * surfaced. Dropped rather than documented.
   *
   * `deviceType` is alive and correct on the *device-list* shape
   * (`SettingsUiDeviceListItem`, read by `deviceUtils.supportsTemperatureDevice`),
   * where the question is what the device IS — a capability — rather than which
   * numbers to display. Do not re-add it here to answer that question; the two
   * surfaces ask different ones.
   */
  binaryControllable?: boolean;
  deviceRole?: 'ev_charger';
  evChargingState?: EvChargingState;
  /**
   * The PRODUCER-RESOLVED current draw (`getCurrentDrawKw`), never the raw
   * `measure_power` observation. REQUIRED: every carrier of this shape — the
   * plan read model, the overview log seam, the settings-UI plan snapshot — is
   * fed from a plan device, which resolves the draw once at `toPlanDevice` and
   * carries it as a required field. An unmetered device resolves to `0`, so
   * there is no absent case for a consumer to invent an answer for.
   *
   * It was an OPTIONAL `measuredPowerKw` carrying exactly this value, and both
   * halves of that were hazards: the name invited consumers to treat it as raw
   * telemetry, and the optionality meant a carrier that forgot to populate it
   * compiled clean and silently read `undefined` — which
   * `isSatisfiedTargetOnlyDevice` scores as `0 kW` and labels a drawing device
   * "Idle".
   */
  currentDrawKw: number;
  /**
   * Draw when running, REQUIRED — the producer's answer for every device, from
   * a rung ladder that ends in a device-class default, so there is no device it
   * has no figure for (`lib/device/devicePowerEstimate.ts`). Required on
   * `PlanInputDevice` and `DevicePlanDevice` already; it was optional only here,
   * on the seam furthest from the producer.
   */
  expectedPowerKw: number;
  reason: DeviceReason;
  /**
   * Producer-resolved: whether PELS manages this device. REQUIRED — the plan
   * producer resolves the owner's setting to a boolean once (`toPlanDevice`)
   * and every plan device carries the answer.
   * Optional here meant three states on the wire for a two-state fact, and
   * every consumer re-derived the same `!== false` collapse for itself.
   */
  controllable: boolean;
  /**
   * Producer-resolved reachability, REQUIRED for the same reason as
   * `controllable`: absence is not a third state, and the collapse belongs at
   * the producer rather than repeated at each reader. Read it as "not known to
   * be unavailable" — the transport resolves an unreadable value optimistically
   * to `true` (see the twin docblock on `DevicePlanDevice`).
   */
  available: boolean;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  shedTemperature?: number | null;
  /**
   * The temperature facet, as ONE atomic optional object: present iff the
   * device is temperature-observed, and complete when present (the producer's
   * atomic facet + total planner resolution; the WebView adapter validates the
   * trio once at `parsePlanSnapshot` and drops a junk facet wholly). There are
   * no flat nullable temperature fields left on this shape — absence of the
   * facet is the one genuine "not a temperature device" state.
   */
  temperature?: PlannedTemperatureState;
  // Truthy while a target write is in flight — a satisfied verdict against the
  // pre-command setpoint would be premature.
  pendingTargetCommand?: unknown;
  // No flat step ids and no flat profile: they live on `steppedLoad` above,
  // which is the discriminant AND the single source for every stepped fact.
  // `steppedLoadProfile` in particular was a ghost here — the producer never
  // wrote it, yet `planCardReasonLine` read it with a fallback.
  binaryCommandPending?: boolean;
  observationStale?: boolean;
  // Drives the "Raised to use your solar power" reason line; included in the overview
  // transition signature so a flip (true→false) re-renders the card even when the
  // normalized plannedTarget is unchanged.
  surplusAbsorbActive?: boolean;
  stateOfCharge?: {
    level: DeviceStateOfChargeSnapshot['level'];
  };
};

export type DeviceOverviewStrings = {
  powerMsg: string | null;
  stateMsg: string;
  usageMsg: string;
  statusMsg: string;
};

// Presence, not a setting comparison. See `DeviceOverviewSteppedLoad`.
//
// A type predicate, so a caller that has asked the question can then read the
// cluster's required members without re-checking. It returned a plain `boolean`
// while every stepped fact also had a flat optional copy, so narrowing bought
// nothing; now the cluster is the only source, and narrowing is what lets
// `planningPowerKw` be read straight rather than through a fallback.
const isSteppedLoadDevice = (
  device: DeviceOverviewSnapshot,
): device is DeviceOverviewSnapshot & { steppedLoad: DeviceOverviewSteppedLoad } => (
  device.steppedLoad !== undefined
);
const isEvChargerDevice = (device: DeviceOverviewSnapshot): boolean => (
  device.deviceRole === 'ev_charger'
);

// Both step ids come off the CLUSTER, which is the corrected source. They used
// to read flat copies carried beside it, and the target one differed: the
// cluster applies `buildOverviewSteppedLoad`'s `plannerOnlyTarget` correction
// (show where the device actually is when the planner aims at a rung the
// confirmed ladder lacks) while the flat copy kept the raw planner id. So the
// stepped card and the transition label below disagreed about the same device.
//
// `null` on the cluster is a real state — nothing reported yet, or no target —
// and both readers already treat a falsy id as "no transition to describe", so
// it maps onto their existing `undefined` contract.
export const getDeviceOverviewReportedStepId = (
  device: Pick<DeviceOverviewSnapshot, 'steppedLoad'>,
): string | undefined => (
  device.steppedLoad?.reportedStepId ?? undefined
);

const getTargetStepId = (device: DeviceOverviewSnapshot): string | undefined => (
  device.steppedLoad?.targetStepId ?? undefined
);

const getSteppedModeTransitionText = (device: DeviceOverviewSnapshot): string | null => {
  const reportedStepId = getDeviceOverviewReportedStepId(device);
  const targetStepId = getTargetStepId(device);

  if (!reportedStepId || !targetStepId || reportedStepId === targetStepId) return null;
  return `${reportedStepId} → ${targetStepId}`;
};

export const isDeviceOverviewSteppedModeTransition = (device: DeviceOverviewSnapshot): boolean => (
  isSteppedLoadDevice(device)
  && !isGrayStateDevice(device)
  && isOnLikeState(device.currentState)
  && getSteppedModeTransitionText(device) !== null
);

const isKeepStateSteppedModeTransition = (device: DeviceOverviewSnapshot): boolean => (
  device.plannedState === 'keep' && isDeviceOverviewSteppedModeTransition(device)
);

const getSteppedUsageStepText = (device: DeviceOverviewSnapshot): string | null => {
  const reportedStepId = getDeviceOverviewReportedStepId(device);
  const targetStepId = getTargetStepId(device);

  // Step ids surface through the shared display formatter ('32a' → '32 A',
  // 'low' → 'Low') so the log line matches the card rail's vocabulary.
  if (reportedStepId) {
    if (targetStepId && targetStepId !== reportedStepId) {
      return `reported: ${formatStepDisplayLabel(reportedStepId)} / target: ${formatStepDisplayLabel(targetStepId)}`;
    }
    return `reported: ${formatStepDisplayLabel(reportedStepId)}`;
  }

  return targetStepId ? `target: ${formatStepDisplayLabel(targetStepId)}` : null;
};

const resolvePlannedPowerState = (
  device: DeviceOverviewSnapshot,
  currentPowerRaw: string,
  currentPower: string,
): string => {
  if (currentPowerRaw === 'not_applicable') return currentPower;

  const isMinTempActive = device.shedAction === 'set_temperature'
    && typeof device.shedTemperature === 'number'
    && device.temperature?.currentTarget === device.shedTemperature;

  switch (device.plannedState) {
    case 'shed':
      return device.shedAction === 'set_temperature' ? 'on' : 'off';
    case 'inactive':
      return currentPowerRaw === 'unknown' ? currentPower : 'off';
    case 'keep':
      return isMinTempActive ? 'on' : currentPower;
    default:
      return device.plannedState || currentPower;
  }
};

/**
 * The rung this cycle's limiting PARKS the device at, or `null` when there is no
 * rung to name — the device is not stepped, the plan named no step, or it named
 * one the ladder does not carry.
 *
 * Shed behaviour is a FLOOR — "worst case, turn off" — not an action. Since
 * 2026-08-17 the planner may leave a `turn_off` stepped device at any rung above
 * that floor and the executor commands exactly that rung
 * (`resolveSteppedLoadDirectShedStepId`, `lib/plan/planSteppedShedResolution.ts`).
 * So the display keys on where the plan actually parks the device, never on the
 * configured behaviour: a charger trimmed to 16 A read "Charging paused" while it
 * drew 3.7 kW.
 */
const resolveParkedShedStep = (device: DeviceOverviewSnapshot): SteppedLoadStep | null => {
  const { steppedLoad } = device;
  const targetStepId = getTargetStepId(device);
  if (!steppedLoad || targetStepId === undefined) return null;
  return steppedLoad.profile.steps.find((candidate) => candidate.id === targetStepId) ?? null;
};

/**
 * Whether a parked rung leaves the device running.
 *
 * Mirrors `isSteppedLoadOffStep` (`packages/contracts/src/deviceControlProfiles.ts`):
 * a rung is off when it draws nothing OR carries the reserved `off` id. Copied
 * rather than imported — shared-domain must not take a runtime VALUE dependency
 * on contracts (`no-runtime-value-deps-on-contracts`; contracts is stripped from
 * the packaged app, so a value import crashes it at boot). That duplication is
 * the sanctioned price of the packaging boundary.
 */
const isRunningStep = (step: SteppedLoadStep): boolean => (
  step.planningPowerW > 0 && step.id !== 'off'
);

const resolveShedStateMsg = (device: DeviceOverviewSnapshot): string => {
  const parkedStep = resolveParkedShedStep(device);
  // Setpoint limiting is named BEFORE any rung. A stepped device can be limited
  // by lowering its setpoint while keeping a running step target, and naming the
  // rung there reported "Limited to Max" for a device whose step never moved —
  // the setpoint is what this cycle lowered, so that is what the owner is told.
  if (device.shedAction === 'set_temperature') return DEVICE_OVERVIEW_LOWERED;
  // Same display formatter as the usage line and the card rail — one entry
  // must not read "Limited to 32a" beside "target: 32 A".
  if (parkedStep !== null && isRunningStep(parkedStep)) {
    return deviceOverviewLimitedToStep(formatStepDisplayLabel(parkedStep.id));
  }
  if (isEvChargerDevice(device)) return DEVICE_OVERVIEW_CHARGING_PAUSED;
  // A `set_step` device parked at the OFF rung is off, and says so: naming the
  // rung there read "Limited to Off", which is both awkward and the same
  // situation a `turn_off` device reports as "Turned off". The bare `Limited`
  // survives for the one case with no rung to name at all.
  if (device.shedAction === 'set_step' && parkedStep === null) return DEVICE_OVERVIEW_LIMITED;
  return DEVICE_OVERVIEW_TURNED_OFF;
};

const resolveEvInactiveStateMsg = (evState: string): string => {
  switch (evState) {
    case 'plugged_out':
      return DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED;
    case 'plugged_in':
    case 'plugged_in_paused':
      return DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING;
    case 'plugged_in_discharging':
      return DEVICE_OVERVIEW_INACTIVE_DISCHARGING;
    default:
      return DEVICE_OVERVIEW_INACTIVE;
  }
};

const resolveEvKeepStateMsg = (device: DeviceOverviewSnapshot, evState: string): string | null => {
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) {
    return DEVICE_OVERVIEW_CHARGING_REQUESTED;
  }
  switch (evState) {
    case 'plugged_in_charging':
      return DEVICE_OVERVIEW_ACTIVE_CHARGING;
    case 'plugged_out':
      return DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED;
    case 'plugged_in':
    case 'plugged_in_paused':
      return DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING;
    case 'plugged_in_discharging':
      return DEVICE_OVERVIEW_INACTIVE_DISCHARGING;
    default:
      return null;
  }
};

const resolveEvStateMsg = (device: DeviceOverviewSnapshot): string | null => {
  if (!isEvChargerDevice(device)) return null;
  const evState = normalizeDeviceState(device.evChargingState);

  // The EV branch runs BEFORE the generic shed branch in `resolveStateMsg`, so
  // this is where a charger's limited line is decided — it used to answer
  // "Charging paused" unconditionally, which is a lie about a charger the plan
  // merely trimmed to a lower rung. One home for the limited line: the shared
  // resolver parks-first, and falls through to "Charging paused" only for a
  // charger the plan actually stops.
  if (device.plannedState === 'shed') return resolveShedStateMsg(device);
  if (device.plannedState === 'inactive') return resolveEvInactiveStateMsg(evState);
  if (device.plannedState === 'keep') return resolveEvKeepStateMsg(device, evState);
  return null;
};

const resolveKeepStateMsg = (device: DeviceOverviewSnapshot): string => {
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) {
    return DEVICE_OVERVIEW_RESUME_REQUESTED;
  }
  if (isOffLikeState(device.currentState)) return DEVICE_OVERVIEW_RESUMING;
  if (normalizeDeviceState(device.currentState) === 'not_applicable') {
    // Keep the chip text in lockstep with the resolved state word: a satisfied
    // target-only device is stamped `idle`, and an idle-toned chip reading
    // "Active (temperature-managed)" would contradict the card one line up.
    if (isSatisfiedTargetOnlyDevice(device)) return DEVICE_OVERVIEW_IDLE;
    return DEVICE_OVERVIEW_ACTIVE_TEMPERATURE_MANAGED;
  }
  return DEVICE_OVERVIEW_ACTIVE;
};

const resolveStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.controllable === false) return DEVICE_OVERVIEW_CAPACITY_CONTROL_OFF;
  if (isGrayStateDevice(device)) {
    return device.available === false ? DEVICE_OVERVIEW_UNAVAILABLE : DEVICE_OVERVIEW_STATE_UNKNOWN;
  }
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (isKeepStateSteppedModeTransition(device)) {
    return `Active (${getSteppedModeTransitionText(device)})`;
  }
  if (device.plannedState === 'shed') return resolveShedStateMsg(device);
  if (device.plannedState === 'inactive') return DEVICE_OVERVIEW_INACTIVE;
  if (device.plannedState === 'keep') return resolveKeepStateMsg(device);
  return DEVICE_OVERVIEW_UNKNOWN;
};

const formatEvSocStatus = (
  stateOfCharge: DeviceOverviewSnapshot['stateOfCharge'],
): string | null => {
  // No level, no line. The card is a glance; there is nothing to qualify,
  // because there is no number.
  const level = stateOfCharge?.level;
  return level?.kind === 'known' ? deviceOverviewEvBatteryStatus(level.percent) : null;
};

const formatUsageText = (params: {
  // Required, mirroring `DeviceOverviewSnapshot.currentDrawKw`: the only caller
  // reads that field, and an unmetered device resolves to `0` rather than to
  // absence. The `Number.isFinite` gate below still stands as the wire-boundary
  // guard.
  measuredKw: number;
  expectedKw?: number;
  // Stepped devices report PLANNING power (the capacity the selected step
  // reserves), which tracked the reported step one moment and the target step
  // the next — labelling that "Expected" made the number look inconsistent.
  expectedLabel?: 'Expected' | 'Planned';
}): string => {
  const { measuredKw, expectedKw, expectedLabel } = params;
  const hasMeasured = typeof measuredKw === 'number' && Number.isFinite(measuredKw);
  const hasExpected = typeof expectedKw === 'number' && Number.isFinite(expectedKw);
  const label = expectedLabel ?? 'Expected';
  if (hasExpected && hasMeasured) {
    return `Measured: ${measuredKw.toFixed(2)} kW / ${label}: ${expectedKw.toFixed(2)} kW`;
  }
  if (hasExpected) return `${label}: ${expectedKw.toFixed(2)} kW`;
  if (hasMeasured) return `Measured: ${measuredKw.toFixed(2)} kW`;
  return DEVICE_OVERVIEW_UNKNOWN;
};

// Always an answer: the live step's draw for a stepped device, and
// `expectedPowerKw` — required — for everything else.
//
// The `?? device.expectedPowerKw` this used to carry inside the stepped branch
// is gone. `planningPowerKw` is required on the cluster, so a stepped device
// always has one; the fallback was covering for the field being optional on the
// snapshot, not for a device that genuinely lacked a figure.
export const getDeviceOverviewExpectedPowerKw = (device: DeviceOverviewSnapshot): number => (
  isSteppedLoadDevice(device) ? device.steppedLoad.planningPowerKw : device.expectedPowerKw
);

const appendOverviewStatus = (statusMsg: string, extraStatus: string | null): string => {
  if (!extraStatus) return statusMsg;
  if (statusMsg === '' || statusMsg === DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER) return extraStatus;
  // Em-dash separator matches the device-card status copy convention. Spec:
  // notes/ui-terminology.md:9, TODO #8 (2026-05-16).
  return `${statusMsg} — ${extraStatus}`;
};

export const formatDeviceOverview = (device: DeviceOverviewSnapshot): DeviceOverviewStrings => {
  const currentPowerRaw = normalizeDeviceState(device.currentState) || 'unknown';
  let powerMsg: string | null = null;
  if (!isSteppedLoadDevice(device) && currentPowerRaw !== 'not_applicable') {
    const currentPower = currentPowerRaw;
    const plannedPowerState = resolvePlannedPowerState(device, currentPowerRaw, currentPower);
    powerMsg = plannedPowerState !== currentPower ? `${currentPower} → ${plannedPowerState}` : plannedPowerState;
  }

  let usageMsg = formatUsageText({
    measuredKw: device.currentDrawKw,
    expectedKw: getDeviceOverviewExpectedPowerKw(device),
    expectedLabel: isSteppedLoadDevice(device) ? 'Planned' : 'Expected',
  });
  if (isSteppedLoadDevice(device)) {
    const stepText = getSteppedUsageStepText(device);
    if (stepText) usageMsg = `${usageMsg} (${stepText})`;
  }

  const statusMsg = appendOverviewStatus(
    formatDeviceReasonUserFacingForDevice(device),
    formatEvSocStatus(device.stateOfCharge),
  );

  return {
    powerMsg,
    stateMsg: resolveStateMsg(device),
    usageMsg,
    statusMsg,
  };
};

const normalizeSignatureNumber = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const isMinTemperatureRestoreActive = (device: DeviceOverviewSnapshot): boolean => (
  device.shedAction === 'set_temperature'
  && typeof device.shedTemperature === 'number'
  && device.temperature?.currentTarget === device.shedTemperature
);

export const buildDeviceOverviewTransitionSignature = (
  device: DeviceOverviewSnapshot,
): string => (
  JSON.stringify({
    currentState: normalizeDeviceState(device.currentState) || 'unknown',
    plannedState: device.plannedState ?? null,
    // The stepped discriminant, as a bit: the signature only ever needs to
    // distinguish a stepped device from a non-stepped one, which is all the
    // retired `controlModel` field told it.
    steppedLoad: device.steppedLoad !== undefined,
    controllable: device.controllable === false,
    available: device.available === false,
    observationStale: device.observationStale === true,
    binaryCommandPending: device.binaryCommandPending === true,
    shedAction: device.shedAction ?? null,
    minTemperatureRestoreActive: isMinTemperatureRestoreActive(device),
    currentDrawKw: normalizeSignatureNumber(device.currentDrawKw),
    expectedPowerKw: normalizeSignatureNumber(getDeviceOverviewExpectedPowerKw(device)),
    reason: buildComparableDeviceReason(device.reason),
    surplusAbsorbActive: device.surplusAbsorbActive === true,
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    targetStepId: getTargetStepId(device) ?? null,
    // The RESOLVED state kind, not the raw temperatures: a satisfied
    // target-only device flipping Running ↔ Idle can have `currentTemperature`
    // as its only changed input, which no other signature field carries — the
    // device log would silently skip the transition. The classification is
    // stable (a 0.1 °C wobble below the epsilon does not change it), so this
    // cannot churn the log the way a raw temperature field would.
    stateKind: resolvePlanStateKind(device),
  })
);
