import { applyShedTemperatureHold, finalizePlanDevices, normalizeShedReasons } from '../../lib/plan/planReasons';
import { buildCeilingShortfallInputs } from '../../lib/plan/planReasonShortfall';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import { buildRestoreHeadroomReason } from '../../lib/plan/planReasonStrings';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../../lib/plan/restore/devices';
import { createPlanEngineState } from '../../lib/plan/planState';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';
import { legacyDeviceReason, reasonText } from '../utils/deviceReasonTestUtils';

// Reads the moved `plannedTarget` off a plan device by narrowing through the
// temperature guard (the field lives on `TemperatureKind`, not the base).
const plannedTargetOf = (device: DevicePlanDevice | undefined): number | undefined =>
  (device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined);

// `buildPlanDevice` does not expose the moved `binaryControl` cluster on its
// override; regroup the observed on-state onto the built device explicitly.
const withBinaryOn = (device: DevicePlanDevice, on: boolean): DevicePlanDevice =>
  withBinaryDiscriminant({ ...device, binaryControl: { on } }) as DevicePlanDevice;

describe('normalizeShedReasons', () => {
  it('normalizes placeholder reasons to the mapped shed reason', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-1',
        plannedState: 'shed',
        reason: legacyDeviceReason('restore (need 1.20kW)')!,
      })],
      shedReasons: new Map([['dev-1', legacyDeviceReason('shed due to hourly budget')!]]),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to hourly budget');
  });

  it('preserves swap reasons instead of replacing them with cooldown text', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: legacyDeviceReason('swapped out for Water Heater')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
    });

    expect(reasonText(device?.reason)).toBe('swapped out for Water Heater');
  });

  it('applies a shortfall reason only when the current reason is generic', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: legacyDeviceReason('keep')!,
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shortfall (need 1.20kW, headroom 0.15kW)');
  });

  it('does not replace budget reasons with shortfall text', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to daily budget')!,
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to daily budget');
  });

  it('does not rewrite capacity shed reasons during restore cooldown for another device', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-1',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map([['dev-1', legacyDeviceReason('shed due to capacity')!]]),
      guardInShortfall: false,
      headroomRaw: 1.5,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to capacity');
  });

  it('preserves neutral startup holds during shed cooldown normalization', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-neutral',
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
    });

    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('preserves neutral startup holds during shortfall normalization', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-neutral',
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('re-attributes carry-forward capacity to dailyBudget when softLimitSource is daily', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-stale-capacity',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
    });

    expect(reasonText(device?.reason)).toBe('shed due to daily budget');
  });

  // Regression: prod 2026-07-25. `softLimitSource` names the BINDING (lower) soft
  // limit, not the one the draw has crossed. With daily binding AND capacity
  // breached, capacity is the constraint doing the work — re-attributing to the
  // daily budget put "Limited by today's daily budget" on a budget-exempt
  // charger's card next to its own "Budget exempt" chip (it could only have been shed
  // because the breach overrode the exemption), and offered a "Let it run now"
  // release that cannot create capacity headroom.
  it('does not re-attribute carry-forward capacity to dailyBudget while capacity is breached', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-breached-capacity',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      capacityBreached: true,
    });

    expect(reasonText(device?.reason)).toBe('shed due to capacity');
  });

  // Covers the OTHER re-attribution site. `buildBaseReason` is the one that fires
  // on the real carry-forward path: a device shed in an earlier cycle drops out of
  // `shedReasons` and arrives with its per-cycle `keep` reason, so the explicit
  // capacity fixture above never reaches it (`normalizeDeviceReason` returns from
  // the sibling guard first). Without this the production hot path is untested.
  it('applies the capacity-breach carve-out on the keep-reason carry-forward path too', () => {
    const build = (capacityBreached: boolean) => normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-carry-forward',
        plannedState: 'shed',
        reason: legacyDeviceReason('keep')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      capacityBreached,
    })[0];

    expect(reasonText(build(true)?.reason)).toBe('shed due to capacity');
    // Daily genuinely binding and not breached: naming the daily budget is right,
    // including for a device that happens to be budget exempt — exemption only
    // blocks daily-budget SHEDDING, not a daily-budget restore hold.
    expect(reasonText(build(false)?.reason)).toBe('shed due to daily budget');
  });

  it('leaves capacity reasons alone when softLimitSource is capacity', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-fresh-capacity',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'capacity',
    });

    expect(reasonText(device?.reason)).toBe('shed due to capacity');
  });

  it('leaves a fresh-this-cycle capacity shed reason alone even when softLimitSource is daily', () => {
    // The shedReasons map is the shedding selector's authoritative output for
    // the current cycle; if it set `capacity` despite daily binding, the
    // selector knows something the normalizer doesn't, and we should not
    // override it.
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-fresh',
        plannedState: 'shed',
        reason: legacyDeviceReason('keep')!,
      })],
      shedReasons: new Map([['dev-fresh', { code: 'capacity', detail: null }]]),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
    });

    expect(reasonText(device?.reason)).toBe('shed due to capacity');
  });

  // Regression: prod 2026-08-01. With the daily budget binding (softLimitSource
  // 'daily', capacity pace 10–19 kW, house at 0.6 kW) every restore-blocked device
  // carried `insufficientHeadroom`, so the cards read "Waiting to resume — X kW
  // more needed" while nothing else was running and the freeable power was zero.
  // The hold is budget pacing; say so. `budgetReleasableHeadroomHold` is the
  // producer-resolved flat semantic from `PlanContext` (daily binding + fresh
  // power + no capacity breach); a stale-hold / fail-closed meter or a genuine
  // capacity breach resolves it false upstream, keeping the headroom framing.
  it('re-attributes a budget-bound insufficientHeadroom restore hold to dailyBudget', () => {
    const build = (budgetReleasableHeadroomHold: boolean) => normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-budget-hold',
        plannedState: 'shed',
        reason: buildRestoreHeadroomReason({
          neededKw: 1.2,
          availableKw: 0.7,
          postReserveMarginKw: -0.75,
          minimumRequiredPostReserveMarginKw: 0.25,
        }),
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0.7,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      budgetReleasableHeadroomHold,
    })[0];

    expect(reasonText(build(true)?.reason)).toBe('shed due to daily budget');
    expect(reasonText(build(false)?.reason)).toContain('insufficient headroom');
  });

  // The breach carve-out sits inside the shared helper, ahead of the flat-field
  // gate: even a stale `budgetReleasableHeadroomHold: true` (impossible from the
  // producer, which folds the breach in — belt and suspenders here) must not
  // re-attribute while capacity is breached.
  it('keeps insufficientHeadroom holds numeric while capacity is breached', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-breach-hold',
        plannedState: 'shed',
        reason: buildRestoreHeadroomReason({
          neededKw: 1.2,
          availableKw: 0.7,
          postReserveMarginKw: -0.75,
          minimumRequiredPostReserveMarginKw: 0.25,
        }),
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0.7,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      capacityBreached: true,
      budgetReleasableHeadroomHold: true,
    });

    expect(reasonText(device?.reason)).toContain('insufficient headroom');
  });

  // Per-axis admission evaluates a budget-exempt candidate on the CAPACITY
  // axis, so its holds are capacity holds — folding them to dailyBudget would
  // offer the budget rescue to a device that is already exempt (a no-op lever).
  it('never folds a budget-exempt device\'s headroom hold to dailyBudget', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-exempt-hold',
        plannedState: 'shed',
        budgetExempt: true,
        reason: buildRestoreHeadroomReason({
          neededKw: 1.4,
          availableKw: 1.7,
          postReserveMarginKw: -0.28,
          minimumRequiredPostReserveMarginKw: 0.25,
        }),
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 1.7,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      budgetReleasableHeadroomHold: true,
    });

    expect(reasonText(device?.reason)).toContain('insufficient headroom');
  });

  it('keeps insufficientHeadroom holds numeric when softLimitSource is capacity', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-capacity-hold',
        plannedState: 'shed',
        reason: buildRestoreHeadroomReason({
          neededKw: 1.2,
          availableKw: 0.7,
          postReserveMarginKw: -0.75,
          minimumRequiredPostReserveMarginKw: 0.25,
        }),
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0.7,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'capacity',
      budgetReleasableHeadroomHold: false,
    });

    expect(reasonText(device?.reason)).toContain('insufficient headroom');
  });

  it('overrides capacity with deferredObjectiveAvoid when the device is in an avoid bucket', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-smart-task',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      deferredObjectiveAvoidDeviceIds: new Set(['dev-smart-task']),
    });

    expect(reasonText(device?.reason)).toBe('waiting for cheaper hours');
  });

  it('prefers deferredObjectiveAvoid over dailyBudget when both apply', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-smart-task-on-daily',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      softLimitSource: 'daily',
      deferredObjectiveAvoidDeviceIds: new Set(['dev-smart-task-on-daily']),
    });

    expect(reasonText(device?.reason)).toBe('waiting for cheaper hours');
  });

  it('does not override shortfall or swap with the deferred-avoid framing', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-swap',
        plannedState: 'shed',
        reason: legacyDeviceReason('swapped out for Water Heater')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      deferredObjectiveAvoidDeviceIds: new Set(['dev-swap']),
    });

    expect(reasonText(device?.reason)).toBe('swapped out for Water Heater');
  });

  // ── Finding A on #1817: surplus hold survives the plan-wide shed cooldown ──
  const AWAITING = { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null };

  it('keeps a surplus-held device on awaiting_solar_surplus during an active shed cooldown', () => {
    // A dump load held for surplus, but the plan-wide shed cooldown is active and an
    // earlier stage (markOffDevicesStayOff) already stamped cooldown_shedding on it.
    // The surplus framing must win — the device is held for surplus, not the cooldown,
    // and the stepped-restore-block invariant keys on `reason.code === awaitingSolarSurplus`.
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'pool-pump',
        plannedState: 'shed',
        surplusOnly: true,
        reason: legacyDeviceReason('cooldown (shedding, 25s remaining)')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
      surplusHoldReasonById: new Map([['pool-pump', AWAITING]]),
    });

    expect(device?.reason).toEqual(AWAITING);
  });

  it('leaves a genuine capacity-cooldown device on cooldown_shedding (not a surplus hold)', () => {
    // Control: a device NOT in the surplus-hold set keeps the cooldown framing.
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-capacity',
        plannedState: 'shed',
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
      surplusHoldReasonById: new Map([['pool-pump', AWAITING]]),
    });

    expect(device?.reason.code).toBe(PLAN_REASON_CODES.cooldownShedding);
  });

  it('lets a FRESH capacity shed decision win over the surplus hold even during cooldown', () => {
    // A dump load genuinely capacity-shed this cycle (fresh shedReason) is real pressure;
    // it must NOT read awaiting_solar_surplus, so the stepped-restore-block still counts it.
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'pool-pump',
        plannedState: 'shed',
        surplusOnly: true,
        reason: legacyDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map([['pool-pump', legacyDeviceReason('shed due to capacity')!]]),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
      surplusHoldReasonById: new Map([['pool-pump', AWAITING]]),
    });

    expect(device?.reason.code).not.toBe(PLAN_REASON_CODES.awaitingSolarSurplus);
  });
});

// The uniform per-cycle shortfall stage (`finalizeCeilingReason`): every
// power-liftable ceiling hold leaves normalization carrying the device's own
// admission gap, computed from the post-hold axes when no producer number
// exists. Regression target: prod 2026-08-02, five devices held on a 0.55 kW
// daily pace rendered the bare "Waiting to resume" because the restore lane
// never evaluated them (headroom −0.99 → pass skipped, reasons carried
// forward), so no producer ever attached a number.
describe('normalizeShedReasons — uniform ceiling shortfall', () => {
  // Fixture need: residualKw.restore 1.0 kW + 0.2 kW buffer = 1.2 kW.
  const heldDevice = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
    id: 'held-dev',
    plannedState: 'shed',
    priority: 3,
    residualKw: { shed: 0, restore: { kw: 1.0, source: 'planning' } },
    reason: { code: 'capacity', detail: null },
    ...overrides,
  });

  const normalize = (params: {
    devices: DevicePlanDevice[];
    capacityAvailableKw: number;
    budgetAvailableKw?: number | null;
    headroomReserves?: readonly { deviceId: string; deviceName: string; priority: number; kw: number }[];
    hourlyBudgetExhausted?: boolean;
    softLimitSource?: 'capacity' | 'daily' | null;
    capacityBreached?: boolean;
  }) => normalizeShedReasons({
    planDevices: params.devices,
    shedReasons: new Map(),
    guardInShortfall: false,
    headroomRaw: params.capacityAvailableKw,
    inCooldown: false,
    activeOvershoot: false,
    shedCooldownRemainingSec: null,
    softLimitSource: params.softLimitSource ?? null,
    capacityBreached: params.capacityBreached ?? false,
    admissionInputs: buildCeilingShortfallInputs({
      ledgerAxes: {
        capacityAvailableKw: params.capacityAvailableKw,
        budgetAvailableKw: params.budgetAvailableKw ?? null,
      },
      headroomReserves: params.headroomReserves ?? [],
      onDevices: params.devices,
      swappedOutFor: new Map(),
      restoredThisCycle: new Set(),
    }),
    hourlyBudgetExhausted: params.hourlyBudgetExhausted ?? false,
  });

  it('attaches the admission gap to a carry-forward capacity hold', () => {
    // gap = 0.25 − (0.5 − 1.2 − 0.25) = 1.2 kW
    const [device] = normalize({ devices: [heldDevice()], capacityAvailableKw: 0.5 });
    expect(device?.reason).toEqual({ code: 'capacity', detail: null, shortfallKw: 1.2 });
  });

  it('attaches THIS device\'s own gap to a swap victim', () => {
    const [device] = normalize({
      devices: [heldDevice({ reason: { code: 'swapped_out', targetName: 'Water heater' } })],
      capacityAvailableKw: 0.5,
    });
    expect(device?.reason).toEqual({ code: 'swapped_out', targetName: 'Water heater', shortfallKw: 1.2 });
  });

  // Freshness wins: a producer number is a snapshot of the rejection that
  // minted it, and carry-forward states keep it on the card while the pace
  // moves (prod 2026-08-02 evening: "2.3 kW more needed" frozen from a
  // transient overshoot dip while the true gap was 1.3 kW).
  it('replaces a carried producer shortfall with the fresh per-cycle gap', () => {
    const [device] = normalize({
      devices: [heldDevice({ reason: { code: 'daily_budget', detail: null, shortfallKw: 0.8 } })],
      capacityAvailableKw: 0.5,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget', detail: null, shortfallKw: 1.2 });
  });

  it('strips a carried shortfall the fresh arithmetic would no longer produce', () => {
    // available 2.0 → admission passes → no number is honest this cycle.
    const [device] = normalize({
      devices: [heldDevice({ reason: { code: 'daily_budget', detail: null, shortfallKw: 0.8 } })],
      capacityAvailableKw: 2.0,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget', detail: null });
  });

  it('keeps the producer number only when the per-axis inputs are absent', () => {
    const [device] = normalizeShedReasons({
      planDevices: [heldDevice({ reason: { code: 'daily_budget', detail: null, shortfallKw: 0.8 } })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0.5,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget', detail: null, shortfallKw: 0.8 });
  });

  // A pending swap TARGET's relief is already committed (its sources are
  // `plannedState: 'shed'`, mid turn-off, absent from the swap surface) — a
  // computed gap would state the full plain deficit the in-flight swap is
  // about to cover.
  it('attaches nothing to a pending swap target', () => {
    const [device] = normalize({
      devices: [heldDevice({ reason: { code: 'swap_pending', targetName: null } })],
      capacityAvailableKw: 0.5,
    });
    expect(device?.reason).toEqual({ code: 'swap_pending', targetName: null });
  });

  it('attaches nothing when the device is blocked only by a startup reservation', () => {
    const [device] = normalize({
      devices: [heldDevice()],
      capacityAvailableKw: 2.0,
      headroomReserves: [{ deviceId: 'other', deviceName: 'Water heater', priority: 1, kw: 1.5 }],
    });
    expect(device?.reason).toEqual({ code: 'capacity', detail: null });
  });

  it('reads the capacity axis for a budget-exempt device', () => {
    const [exempt, bound] = normalize({
      devices: [
        heldDevice({ id: 'exempt-dev', budgetExempt: true }),
        heldDevice({ id: 'bound-dev', budgetExempt: false }),
      ],
      capacityAvailableKw: 2.0,
      budgetAvailableKw: 0.1,
    });
    // Capacity axis admits the exempt device → no gap to state; the bare line
    // is honest. The non-exempt sibling gates on min(cap, budget):
    // gap = 0.25 − (0.1 − 1.2 − 0.25) = 1.6 kW.
    expect(exempt?.reason).toEqual({ code: 'capacity', detail: null });
    expect(bound?.reason).toEqual({ code: 'capacity', detail: null, shortfallKw: 1.6 });
  });

  // Prod repro (2026-08-02): pace 0.55 kW, draw 1.54 kW → available −0.99 kW,
  // restore pass never ran. Every held card must resolve a number now.
  it('gives every deep-hold device a number even when available power is negative', () => {
    const devices = normalize({
      devices: [1, 2, 3, 4, 5].map((n) => heldDevice({
        id: `held-${n}`,
        reason: { code: 'daily_budget', detail: null },
      })),
      capacityAvailableKw: 20.27 - 1.54,
      budgetAvailableKw: -0.99,
      softLimitSource: 'daily',
    });
    for (const device of devices) {
      // gap = 0.25 − (−0.99 − 1.2 − 0.25) = 2.69 → 2.7 kW on the display grid.
      expect(device.reason).toEqual({ code: 'daily_budget', detail: null, shortfallKw: 2.7 });
    }
  });

  describe('hourly-exhausted fold', () => {
    it('folds ceiling holds to hourlyBudget with no kW while the hour is spent', () => {
      const devices = normalize({
        devices: [
          heldDevice({ id: 'cap-dev', reason: { code: 'capacity', detail: null } }),
          heldDevice({ id: 'daily-dev', reason: { code: 'daily_budget', detail: null, shortfallKw: 0.8 } }),
          heldDevice({ id: 'swap-dev', reason: { code: 'swapped_out', targetName: 'Water heater' } }),
        ],
        capacityAvailableKw: 0.5,
        hourlyBudgetExhausted: true,
      });
      expect(devices[0]?.reason).toEqual({ code: 'hourly_budget', detail: null });
      expect(devices[1]?.reason).toEqual({ code: 'hourly_budget', detail: null });
      // Swap holds keep their framing but render bare: spent kWh cannot be
      // un-spent, so a kW figure would be dishonest for them too — the attach
      // is suspended (and any carried number stripped) for the whole hour.
      expect(devices[2]?.reason).toEqual({ code: 'swapped_out', targetName: 'Water heater' });
    });

    // The inverse fold: nothing else rewrites a carried-forward `hourlyBudget`
    // reason once the hour rolls (it is not in `shouldNormalizeReason`), so the
    // finalize stage must re-attribute it to the binding ceiling — with the
    // fresh gap attached — or the "next hour" line outlives its hour.
    it('re-attributes a stale hourlyBudget hold once the hour rolls over', () => {
      const roll = (params: {
        softLimitSource: 'capacity' | 'daily';
        capacityBreached?: boolean;
        budgetExempt?: boolean;
      }) => normalize({
        devices: [heldDevice({
          reason: { code: 'hourly_budget', detail: null },
          budgetExempt: params.budgetExempt ?? false,
        })],
        capacityAvailableKw: 0.5,
        softLimitSource: params.softLimitSource,
        capacityBreached: params.capacityBreached ?? false,
      })[0];

      expect(roll({ softLimitSource: 'daily' })?.reason)
        .toEqual({ code: 'daily_budget', detail: null, shortfallKw: 1.2 });
      expect(roll({ softLimitSource: 'daily', capacityBreached: true })?.reason)
        .toEqual({ code: 'capacity', detail: null, shortfallKw: 1.2 });
      // Per-axis admission evaluates an exempt candidate on capacity, so its
      // hold is a capacity hold — never a budget label next to a "Budget exempt" chip.
      expect(roll({ softLimitSource: 'daily', budgetExempt: true })?.reason)
        .toEqual({ code: 'capacity', detail: null, shortfallKw: 1.2 });
      expect(roll({ softLimitSource: 'capacity' })?.reason)
        .toEqual({ code: 'capacity', detail: null, shortfallKw: 1.2 });
    });
  });
});

describe('finalizePlanDevices', () => {
  it('strips candidate reasons before returning finalized plan devices', () => {
    const finalized = finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: legacyDeviceReason('keep')!,
      candidateReasons: {
        offStateAnalysis: 'restore (need 1.20kW, headroom 0.30kW)',
      },
    })]);

    expect(finalized.planDevices[0]).not.toHaveProperty('candidateReasons');
  });

  it('requires finalized devices to carry a structured reason contract', () => {
    const finalized = finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
    })]);

    expect(finalized.planDevices[0]?.reason.code).toBe('keep');
  });

  it('throws in tests when a final reason/state pair is not allowed', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: legacyDeviceReason('restore (need 1.20kW, headroom 0.30kW)')!,
    })])).toThrow(/Invalid plan reason pair/);
  });

  it('allows legacy restore cooldown shed reasons that are still emitted by stay-off paths', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: legacyDeviceReason('cooldown (restore, 30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows meter-settling shed reasons for blocked restore candidates', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: legacyDeviceReason('meter settling (30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows legacy restore cooldown keep reasons that still surface during restore holds', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: legacyDeviceReason('cooldown (restore, 30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows restore pending reasons for keep devices that are waiting on stepped confirmation', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: legacyDeviceReason('restore pending (30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows an awaitingSolarSurplus shed reason on a surplusOnly dump-load device', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      surplusOnly: true,
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    })])).not.toThrow();
  });

  it('throws when an awaitingSolarSurplus reason rides a device WITHOUT the surplusOnly posture', () => {
    // Cross-field invariant: the reason mis-attributes the starvation-pause
    // classification if it appears on a non-dump-load device.
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    })])).toThrow(/Invalid plan reason pair|surplusOnly/);
  });
});

describe('applyShedTemperatureHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Per-axis parity for the setpoint lane: a budget-exempt setpoint-shed device
  // admits its raise against the CAPACITY axis, a non-exempt one stays held by
  // the tight budget axis — same split the binary/stepped ledger lanes apply.
  it('admits an exempt setpoint device on the capacity axis while a non-exempt one stays held', () => {
    const run = (budgetExempt: boolean) => {
      const state = createPlanEngineState();
      state.lastPlannedShedIds.add('dev-temp');
      return applyShedTemperatureHold({
        planDevices: [withBinaryOn(buildPlanDevice({
          id: 'dev-temp',
          name: 'Water Heater',
          currentState: 'keep',
          plannedState: 'shed',
          budgetExempt,
          expectedPowerKw: 1.2,
          currentTarget: 16,
          plannedTarget: 16,
          shedAction: 'set_temperature',
          shedTemperature: 16,
          reason: legacyDeviceReason('shed due to daily budget')!,
        }), true)],
        state,
        shedReasons: new Map(),
        inShedWindow: false,
        inCooldown: false,
        activeOvershoot: false,
        availableHeadroom: 0.3,
        ledger: buildRestoreHeadroomLedger({ capacityAvailableKw: 8, budgetAvailableKw: 0.3 }),
        restoredOneThisCycle: false,
        restoredThisCycle: new Set(),
        shedCooldownRemainingSec: null,
        holdDuringRestoreCooldown: false,
        restoreCooldownSeconds: 60,
        restoreCooldownRemainingSec: null,
        getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
      });
    };

    // A 'restore' decision passes the device through for the later raise and
    // flips restoredOneThisCycle; a blocked one stamps the headroom hold reason.
    const exempt = run(true);
    const nonExempt = run(false);
    expect(exempt.restoredOneThisCycle).toBe(true);
    expect(nonExempt.restoredOneThisCycle).toBe(false);
    expect(reasonText(nonExempt.planDevices[0]?.reason)).toContain('insufficient headroom');
  });

  it('keeps existing special shed reasons while temperature hold is active', () => {
    const state = createPlanEngineState();

    const result = applyShedTemperatureHold({
      planDevices: [withBinaryOn(buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'keep',
        plannedState: 'shed',
        currentTarget: 16,
        plannedTarget: 16,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        reason: legacyDeviceReason('swap pending')!,
      }), true)],
      state,
      shedReasons: new Map(),
      inShedWindow: true,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 1,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });

    expect(reasonText(result.planDevices[0]?.reason)).toBe('swap pending');
    expect(plannedTargetOf(result.planDevices[0])).toBe(16);
  });

  it('preserves neutral startup holds for set_temperature devices', () => {
    const state = createPlanEngineState();

    const result = applyShedTemperatureHold({
      planDevices: [withBinaryOn(buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: 21,
        plannedTarget: 21,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      }), false)],
      state,
      shedReasons: new Map(),
      inShedWindow: true,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 1,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });

    expect(result.planDevices[0]?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
    expect(plannedTargetOf(result.planDevices[0])).toBe(21);
  });

  it('aborts target restore backoff while shortfall is active', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastPlannedShedIds = new Set(['dev-temp']);
    state.activationAttemptByDevice['dev-temp'] = {
      penaltyLevel: 1,
      lastSetbackMs: now - 1_000,
    };

    const held = applyShedTemperatureHold({
      planDevices: [withBinaryOn(buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'keep',
        plannedState: 'keep',
        currentTarget: 16,
        plannedTarget: 21,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        expectedPowerKw: 1,
        powerKw: 1,
      }), true)],
      state,
      shedReasons: new Map(),
      inShedWindow: false,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 3,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      guardInShortfall: true,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });

    const [device] = normalizeShedReasons({
      planDevices: held.planDevices,
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: -0.5,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(device?.plannedState).toBe('shed');
    expect(plannedTargetOf(device)).toBe(16);
    expect(reasonText(device?.reason)).toBe('shortfall (need 1.20kW, headroom -0.50kW)');
  });
});
