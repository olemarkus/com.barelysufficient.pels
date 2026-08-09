import type { PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';
import type { StructuredDebugEmitter } from '../logging/logger';
import type {
  BinaryControlCapabilityId,
  TargetCapabilitySnapshot,
} from '../../packages/contracts/src/types';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import {
  clearSurplusEligibility,
  SURPLUS_ABSORB_HARD_OFF_IMPORT_KW,
  SURPLUS_ABSORB_RESERVE_KW,
  syncSurplusEligibilityState,
} from './admission';
import { supportsTemperatureBoostDevice } from './planTemperatureBoost';

// Per-device price-opt blob, extended with the surplus-absorb opt-in fields it
// rides. By convention the planner keeps a local structural copy of this blob
// (matching the inline shapes in planEngine/planBuilder) so it depends on the
// settings-deps seam rather than lib/price's persistence type; optional fields
// keep non-solar blobs byte-identical.
export type PriceOptDeviceConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  surplusWilling?: boolean;
  surplusDelta?: number;
};

type SurplusConfig = { surplusWilling?: boolean; surplusDelta?: number };

// Local guard — kept off lib/utils so this new plan module stays self-contained
// (per the lib/plan ↛ lib/utils path rule).
const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const positiveOrZero = (value: unknown): number => (isFiniteNumber(value) && value > 0 ? value : 0);

// A device only absorbs surplus when it is willing AND has a real (finite, > 0)
// lift configured; a no-op (zero/absent/NaN delta) must not be admitted to the
// allocator, or it would reserve export it never draws and starve lower-priority
// devices.
const willingWithLift = (config: SurplusConfig | undefined): boolean => (
  config?.surplusWilling === true && isFiniteNumber(config.surplusDelta) && config.surplusDelta > 0
);

/**
 * "Run on solar surplus" dump-load candidacy (PR-7) — the SINGLE resolution of
 * the binary posture, evaluated once by the producer (`toPlanDevice`) onto the
 * flat `PlanInputDevice.surplusOnly` bit. The same `surplusWilling` opt-in in
 * the per-device price-opt blob disambiguates by modality: a temperature device
 * gets the setpoint lift (above), a plain binary device gets this baseline-off
 * dump-load posture (`surplusDelta` is ignored). Candidates are exactly the
 * plain binary loads: not temperature (no `target_temperature`), not stepped,
 * not continuous / target-power, not EV (class or `evcharger_charging`
 * capability), and both managed and power-limit-controllable. The
 * continuous/target-power/non-binary classification is pre-resolved AT THE
 * PRODUCER into the flat `plainBinaryControlModel` bit, so this planner helper
 * carries no control-model / target-power branch (control-model vocab rule).
 * Structural params so the producer can
 * call it on the raw snapshot; the runtime predicates match the plan guards AND
 * the settings-UI gate (`resolveDeviceDetailControlMode !== 'default'`), so
 * runtime candidacy never disagrees with what the toggle offers — a device the
 * UI classifies continuous/preset/stepped is never stamped `surplusOnly`.
 *
 * Candidacy is SOURCE-INDEPENDENT but NOT unconditional. It used to carry a
 * `meteredPowerSource` bit on the premise that surplus "physically cannot exist
 * on the flow power source". That reasoning was wrong — both sources report
 * signed net, and the measured pool is `-signedNetKw` (`composeSurplusPool`)
 * with no production term in its path — but the bit was doing real work, and
 * dropping it outright re-opened the trap it had been holding shut: a device
 * stamped `surplusOnly` in a home whose pool can never open is held OFF
 * forever by `resolveSurplusHold`, with no time-based escape.
 *
 * `surplusPoolReachable` replaces it with the honest question — has this home
 * been observed to export, or can its curtailment estimator contribute? — which
 * is a runtime fact about accumulated evidence rather than a property of the
 * configured source. A flow home sending `import − export` passes it; a flow
 * home whose Flow predates signed watts does not, and its dump load keeps
 * running. Resolved at the producer (`resolveSurplusPoolReachable`) so this
 * helper carries no tracker or estimator branch.
 */
export function resolveSurplusOnlyPosture(params: {
  surplusWilling: boolean | undefined;
  controlCapabilityId: BinaryControlCapabilityId | undefined;
  deviceClass: string | undefined;
  targets: readonly TargetCapabilitySnapshot[] | undefined;
  steppedLoadProfile: { model?: string } | undefined;
  // Producer-resolved: true only for a plain binary-power control device — i.e.
  // NOT an enabled continuous / target-power (EV-preset) config and NOT a
  // non-binary control model. Resolved at the producer so this planner helper
  // carries no target-power / control-model branch.
  plainBinaryControlModel: boolean;
  controllable: boolean;
  managed: boolean;
  // Producer-resolved: can this home's surplus pool ever be non-zero? False
  // means no surplus can arrive, so stamping the posture would hold the device
  // off indefinitely rather than merely leaving it idle.
  surplusPoolReachable: boolean;
}): boolean {
  return params.surplusWilling === true
    && params.surplusPoolReachable
    && params.controlCapabilityId !== undefined
    && params.controlCapabilityId !== 'evcharger_charging'
    && !isEvDevice({ deviceClass: params.deviceClass, controlCapabilityId: params.controlCapabilityId })
    && params.steppedLoadProfile?.model !== 'stepped_load'
    && params.plainBinaryControlModel
    && params.targets?.some((target) => target.id === 'target_temperature') !== true
    && params.controllable !== false
    && params.managed !== false;
}

// Hard-off: the release condition is unambiguous — the whole-home signal is
// lost, or the home is drawing sustained grid import beyond what a zero-export
// controller's standing import can explain. The gate may then release an
// engaged lift without waiting out the min dwell (the dwell only protects the
// passing-cloud dip, where net hovers near zero).
const isHardOffCondition = (powerOk: boolean, signedNetKw: number | null): boolean => (
  !powerOk || (isFiniteNumber(signedNetKw) && signedNetKw > SURPLUS_ABSORB_HARD_OFF_IMPORT_KW)
);

// Compose the whole-home surplus budget: measured export + the add-back of
// already-absorbing willing devices + the producer-resolved inferred curtailed
// surplus (max(0, term)). Emits the `surplus_pool` composition record once per
// pass — the only place the inferred term is distinguishable from measured
// export (downstream sees only the flat pool).
function composeSurplusPool(params: {
  willing: PlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number;
  inferredSurplusKw: number | null | undefined;
  debugStructured?: StructuredDebugEmitter;
}): number {
  let addBackKw = 0;
  for (const dev of params.willing) {
    if (params.state.surplusEligibilityByDevice[dev.id]?.eligible === true) {
      addBackKw += positiveOrZero(dev.currentDrawKw);
    }
  }
  const measuredExportKw = -params.signedNetKw;
  const inferredContributionKw = positiveOrZero(params.inferredSurplusKw);
  const poolKw = measuredExportKw + addBackKw + inferredContributionKw;
  // Log the CLAMPED contribution that actually entered the pool, so the three
  // components sum to poolKw (a null/negative raw term would otherwise make the
  // record fail to reconcile). The raw term never reaches here negative — the
  // producer clamps at 0 or yields null — so this only differs from the raw on
  // the absent/junk cases, which contribute nothing anyway.
  params.debugStructured?.({
    event: 'surplus_pool',
    measuredExportKw,
    addBackKw,
    inferredSurplusKw: inferredContributionKw,
    poolKw,
  });
  return poolKw;
}

/**
 * Priority-greedy surplus allocator — the *producer* of surplus-absorb
 * eligibility. Runs once per plan build, BEFORE per-device target resolution, and
 * reserves the whole-home export budget across all willing temperature devices in
 * priority order, so two devices cannot both engage on the same surplus and
 * oscillate (the limit cycle). It writes each device's eligibility into
 * `PlanEngineState`; the prep path (`applySurplusAbsorbDelta`) only reads the flat
 * bit.
 *
 * Budget baseline = the export that would exist if no willing device absorbed:
 * `-net + Σ measuredDraw(eligible willing devices) + inferred curtailed surplus`.
 * Adding back the draw of already-absorbing devices keeps the pool from being
 * double-charged for power the measured net already reflects. The inferred term
 * (producer: `lib/solar/curtailmentSurplus.ts`, injected flat through the plan
 * deps) is production a zero-export inverter is throttling away — it enlarges
 * the pool exactly like measured export, and every safety decision about it
 * (import guard, verification, battery suppression) is already resolved in the
 * producer: this allocator never branches on where the pool's kW came from.
 * Each admitted/settling device then reserves its expected draw from the running
 * pool, so lower-priority devices only see what is left. Priority is top-first
 * (PELS priority `1` is highest), so the most important willing device claims
 * scarce surplus before the rest.
 *
 * The willing set is the union of BOTH surplus modalities in ONE pool, ordered
 * purely by user priority: temperature devices with a real lift
 * (`willingWithLift`) and binary dump loads carrying the producer-resolved
 * `surplusOnly` posture. Both reserve `getHighestKnownPowerKw` from the same pool and
 * run the same settle/dwell/hard-off gate, so a thermostat and a pool pump can
 * never both engage on the same export.
 */
export function resolveSurplusEligibility(params: {
  devices: PlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number | null;
  // Producer-resolved inferred curtailed-surplus term (kW); null/undefined when
  // absent or currently suppressed. Folded into the pool as max(0, term) — it can
  // only ever ENLARGE the pool, and the `powerOk` gate below is unaffected: a
  // fresh measured meter is still required before any raise (never raise blind
  // on inference alone).
  inferredSurplusKw?: number | null;
  getConfig: (deviceId: string) => SurplusConfig | undefined;
  getPriority: (deviceId: string) => number;
  // Smart-task precedence at the ALLOCATION stage (mirrors the hold exclusion):
  // a device an active deferred objective currently governs must never be
  // eligible for surplus and must never RESERVE the shared pool ahead of a
  // lower-priority willing device. Excluded devices are dropped from the willing
  // set below, and the lockstep cleanup then clears any latched eligibility so a
  // newly-governed device stops reserving immediately. Empty/absent in the common
  // case (no smart tasks) — byte-identical there.
  excludeIds?: ReadonlySet<string>;
  debugStructured?: StructuredDebugEmitter;
  nowTs?: number;
}): void {
  const { state, getConfig, getPriority } = params;
  const excludeIds = params.excludeIds;
  // One timestamp for the whole admission pass, so a single plan build cannot
  // flip devices on different milliseconds at the settle/dwell threshold.
  const nowTs = params.nowTs ?? Date.now();
  const willing = params.devices.filter(
    (dev) => (excludeIds === undefined || !excludeIds.has(dev.id))
      && (dev.surplusOnly === true
        || (willingWithLift(getConfig(dev.id)) && supportsTemperatureBoostDevice(dev))),
  );

  // Drop stale eligibility for any tracked device that is no longer a willing
  // candidate this cycle (its mode target went missing, it stopped being willing,
  // or its lift was cleared). Otherwise it would re-engage from `eligible = true`
  // with no surplus when it returns to the candidate set, lifting the setpoint
  // until the release settle expires. Departed-from-snapshot devices are pruned by
  // the lockstep cleanup; this catches the still-present-but-not-a-candidate case.
  const willingIds = new Set(willing.map((dev) => dev.id));
  for (const deviceId of Object.keys(state.surplusEligibilityByDevice)) {
    if (!willingIds.has(deviceId)) clearSurplusEligibility(state, deviceId);
  }
  // Prune the parallel lift-active map too: a device that departed the snapshot
  // (or stopped being a candidate) while its `surplusAbsorbActiveByDevice` flag
  // was true would otherwise keep it true forever, so `Object.values(...).some()`
  // in the curtailment estimator reports an engaged lift indefinitely and its
  // `lastLiftEngaged` never clears.
  for (const deviceId of Object.keys(state.surplusAbsorbActiveByDevice)) {
    if (!willingIds.has(deviceId)) delete state.surplusAbsorbActiveByDevice[deviceId];
  }

  if (willing.length === 0) return;

  // `signedNetKw` is already null when this cycle had no trustworthy total, so
  // finiteness is the only check left — there is no provenance to re-derive.
  const powerOk = isFiniteNumber(params.signedNetKw);
  const hardOff = isHardOffCondition(powerOk, params.signedNetKw);
  if (!powerOk) {
    // Power unknown/stale: no surplus to allocate — let every willing device release.
    for (const dev of willing) {
      syncSurplusEligibilityState({
        state,
        deviceId: dev.id,
        willing: true,
        availableSurplusKw: null,
        expectedDrawKw: getHighestKnownPowerKw(dev).kw,
        hardOff,
        nowTs,
      });
    }
    return;
  }

  let poolKw = composeSurplusPool({
    willing,
    state,
    signedNetKw: params.signedNetKw as number,
    inferredSurplusKw: params.inferredSurplusKw,
    debugStructured: params.debugStructured,
  });

  // Top priority first (PELS priority `1` is highest — ascending order).
  const ordered = [...willing].sort((a, b) => getPriority(a.id) - getPriority(b.id));
  for (const dev of ordered) {
    const expectedDrawKw = getHighestKnownPowerKw(dev).kw;
    const { eligible } = syncSurplusEligibilityState({
      state,
      deviceId: dev.id,
      willing: true,
      availableSurplusKw: poolKw,
      expectedDrawKw,
      hardOff,
      nowTs,
    });
    // Reserve the draw of any device that is eligible OR settling toward engage, so
    // a lower-priority device cannot claim the same surplus.
    if (eligible || poolKw >= expectedDrawKw + SURPLUS_ABSORB_RESERVE_KW) {
      poolKw -= expectedDrawKw;
    }
  }
}

/**
 * Apply the surplus-absorb lift to a device's mode setpoint. Eligibility is
 * resolved up-front by {@link resolveSurplusEligibility}; this only reads the flat
 * bit. Capacity-independent — the capacity layer stays the ceiling. Raise-only,
 * and it outranks an expensive-hour reduction (surplus is free even on an
 * expensive grid hour), so the lift comes off the bare mode baseline and wins
 * against the price-adjusted target. Only ever called for a `mode`-seed
 * temperature device.
 */
export function applySurplusAbsorbDelta(params: {
  baseTarget: number;
  pricedTarget: number;
  dev: PlanInputDevice;
  config: SurplusConfig | undefined;
  state: PlanEngineState;
}): number {
  const { baseTarget, pricedTarget, dev, config, state } = params;
  // Finite guard: a corrupt persisted NaN/Infinity must never reach the setpoint.
  const surplusDelta = isFiniteNumber(config?.surplusDelta) ? config.surplusDelta : 0;
  if (config?.surplusWilling !== true || surplusDelta <= 0) {
    // Not a real absorber (unwilling or no lift): drop any stale eligibility the
    // allocator no longer maintains.
    clearSurplusEligibility(state, dev.id);
    return pricedTarget;
  }
  if (state.surplusEligibilityByDevice[dev.id]?.eligible !== true) return pricedTarget;
  return Math.max(pricedTarget, baseTarget + surplusDelta);
}
