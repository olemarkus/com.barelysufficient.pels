import type { PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';
import { getRestoreDrawKw } from '../observer/observedPower';
import {
  clearSurplusEligibility,
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
 * Priority-greedy surplus allocator — the *producer* of surplus-absorb
 * eligibility. Runs once per plan build, BEFORE per-device target resolution, and
 * reserves the whole-home export budget across all willing temperature devices in
 * priority order, so two devices cannot both engage on the same surplus and
 * oscillate (the limit cycle). It writes each device's eligibility into
 * `PlanEngineState`; the prep path (`applySurplusAbsorbDelta`) only reads the flat
 * bit.
 *
 * Budget baseline = the export that would exist if no willing device absorbed:
 * `-net + Σ measuredDraw(eligible willing devices)`. Adding back the draw of
 * already-absorbing devices keeps the pool from being double-charged for power
 * the measured net already reflects. Each admitted/settling device then reserves
 * its expected draw from the running pool, so lower-priority devices only see what
 * is left. Priority is top-first (PELS priority `1` is highest), so the most
 * important willing device claims scarce surplus before the rest.
 */
export function resolveSurplusEligibility(params: {
  devices: PlanInputDevice[];
  state: PlanEngineState;
  signedNetKw: number | null;
  powerKnown: boolean;
  getConfig: (deviceId: string) => SurplusConfig | undefined;
  getPriority: (deviceId: string) => number;
  nowTs?: number;
}): void {
  const { state, getConfig, getPriority } = params;
  // One timestamp for the whole admission pass, so a single plan build cannot
  // flip devices on different milliseconds at the settle/dwell threshold.
  const nowTs = params.nowTs ?? Date.now();
  const willing = params.devices.filter(
    (dev) => willingWithLift(getConfig(dev.id)) && supportsTemperatureBoostDevice(dev),
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

  if (willing.length === 0) return;

  const powerOk = params.powerKnown && isFiniteNumber(params.signedNetKw);
  if (!powerOk) {
    // Power unknown/stale: no surplus to allocate — let every willing device release.
    for (const dev of willing) {
      syncSurplusEligibilityState({
        state,
        deviceId: dev.id,
        willing: true,
        availableSurplusKw: null,
        expectedDrawKw: getRestoreDrawKw(dev).kw,
        nowTs,
      });
    }
    return;
  }

  let addBackKw = 0;
  for (const dev of willing) {
    if (state.surplusEligibilityByDevice[dev.id]?.eligible === true) {
      addBackKw += positiveOrZero(dev.measuredPowerKw);
    }
  }
  let poolKw = -(params.signedNetKw as number) + addBackKw;

  // Top priority first (PELS priority `1` is highest — ascending order).
  const ordered = [...willing].sort((a, b) => getPriority(a.id) - getPriority(b.id));
  for (const dev of ordered) {
    const expectedDrawKw = getRestoreDrawKw(dev).kw;
    const { eligible } = syncSurplusEligibilityState({
      state,
      deviceId: dev.id,
      willing: true,
      availableSurplusKw: poolKw,
      expectedDrawKw,
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
