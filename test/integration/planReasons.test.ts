import { applyShedTemperatureHold, finalizePlanDevices, normalizeShedReasons } from '../../lib/plan/planReasons';
import { buildCeilingShortfallInputs, resolveCeilingShortfall } from '../../lib/plan/planReasonShortfall';
import { computeBaseRestoreNeed } from '../../lib/plan/restore/accounting';
import { getRestoreNeed } from '../../lib/plan/restore/support';
import { RESTORE_ADMISSION_FLOOR_KW, RESTORE_ADMISSION_RESERVE_KW } from '../../lib/plan/planConstants';
import { buildExecutableTargetIntent } from '../../lib/executor/executableTargetProjection';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import { buildRestoreHeadroomReason } from '../../lib/plan/planReasonStrings';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../../lib/plan/restore/devices';
import { createPlanEngineState } from '../../lib/plan/planState';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';
import { fixtureDeviceReason, reasonText } from '../utils/deviceReasonTestUtils';

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
        reason: fixtureDeviceReason('restore low -> high (need 1.20kW)')!,
      })],
      shedReasons: new Map([['dev-1', fixtureDeviceReason('shed due to hourly budget')!]]),
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
        reason: fixtureDeviceReason('swapped out for Water Heater')!,
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
        reason: fixtureDeviceReason('keep')!,
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
        reason: fixtureDeviceReason('shed due to daily budget')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map([['dev-1', fixtureDeviceReason('shed due to capacity')!]]),
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

  // Both stay-off lanes rank startup stabilization ABOVE the shed cooldown
  // (`resolveOffDeviceReason`). The normalizer used to silently re-rank them the
  // other way, so a device the lanes had just labelled `startupStabilization`
  // read "will try to resume in Ns" for any boot where some device happened to
  // be shed inside the last 60 s — hiding the longer, real cause.
  it('preserves startup stabilization during shed cooldown normalization', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-startup',
        plannedState: 'shed',
        reason: { code: PLAN_REASON_CODES.startupStabilization },
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
    });

    expect(device?.reason.code).toBe(PLAN_REASON_CODES.startupStabilization);
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('keep')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('keep')!,
      })],
      shedReasons: new Map([['dev-fresh', { code: 'capacity' }]]),
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('swapped out for Water Heater')!,
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
  const AWAITING = { code: PLAN_REASON_CODES.awaitingSolarSurplus };

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
        reason: fixtureDeviceReason('cooldown (shedding, 25s remaining)')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
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
        reason: fixtureDeviceReason('shed due to capacity')!,
      })],
      shedReasons: new Map([['pool-pump', fixtureDeviceReason('shed due to capacity')!]]),
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
  // Fixed clock, so the recent-shed inflation window is driven by explicit
  // timestamps instead of wall time.
  const SHORTFALL_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

  // Fixture need: residualKw.restore 1.0 kW + 0.2 kW buffer = 1.2 kW.
  const heldDevice = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
    id: 'held-dev',
    plannedState: 'shed',
    priority: 3,
    residualKw: { shed: 0, restore: { kw: 1.0, source: 'planning' } },
    reason: { code: 'capacity' },
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
    lastDeviceShedMsById?: Readonly<Record<string, number>>;
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
      lastDeviceShedMsById: params.lastDeviceShedMsById ?? {},
      nowMs: SHORTFALL_NOW_MS,
    }),
    hourlyBudgetExhausted: params.hourlyBudgetExhausted ?? false,
  });

  it('attaches the admission gap to a carry-forward capacity hold', () => {
    // gap = 0.25 − (0.5 − 1.2 − 0.25) = 1.2 kW
    const [device] = normalize({ devices: [heldDevice()], capacityAvailableKw: 0.5 });
    expect(device?.reason).toEqual({ code: 'capacity', shortfallKw: 1.2 });
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
      devices: [heldDevice({ reason: { code: 'daily_budget', shortfallKw: 0.8 } })],
      capacityAvailableKw: 0.5,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget', shortfallKw: 1.2 });
  });

  it('strips a carried shortfall the fresh arithmetic would no longer produce', () => {
    // available 2.0 → admission passes → no number is honest this cycle.
    const [device] = normalize({
      devices: [heldDevice({ reason: { code: 'daily_budget', shortfallKw: 0.8 } })],
      capacityAvailableKw: 2.0,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget' });
  });

  it('keeps the producer number only when the per-axis inputs are absent', () => {
    const [device] = normalizeShedReasons({
      planDevices: [heldDevice({ reason: { code: 'daily_budget', shortfallKw: 0.8 } })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0.5,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });
    expect(device?.reason).toEqual({ code: 'daily_budget', shortfallKw: 0.8 });
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

  // Parity with the restore gate, stated without repeating its constants: the
  // gate admits at `available ≥ getRestoreNeed().needed + RESERVE + FLOOR`, so
  // the card must find no gap exactly there and a gap just below it. The
  // recent-shed inflation lives inside `getRestoreNeed`, and computing the card
  // from the un-inflated base made the resolver answer `no_gap` — "would be
  // admitted right now" — on the very cycle the gate rejected the device.
  describe('agrees with the restore gate at its own admission boundary', () => {
    const ADMISSION_MARGIN_KW = RESTORE_ADMISSION_RESERVE_KW + RESTORE_ADMISSION_FLOOR_KW;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SHORTFALL_NOW_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('flips from gap to no_gap at the need the gate rejects on', () => {
      const dev = heldDevice();
      const state = createPlanEngineState();
      state.lastDeviceShedMs[dev.id] = SHORTFALL_NOW_MS - 60_000;
      const gateNeededKw = getRestoreNeed(dev, state).needed;
      const shortfallInputs = (capacityAvailableKw: number) => buildCeilingShortfallInputs({
        ledgerAxes: { capacityAvailableKw, budgetAvailableKw: null },
        headroomReserves: [],
        onDevices: [],
        swappedOutFor: new Map(),
        restoredThisCycle: new Set(),
        lastDeviceShedMsById: state.lastDeviceShedMs,
        nowMs: SHORTFALL_NOW_MS,
      });

      // The inflation is real, so the gate is asking for more than the base need.
      expect(gateNeededKw).toBeGreaterThan(computeBaseRestoreNeed(dev).needed);
      expect(resolveCeilingShortfall({
        dev,
        inputs: shortfallInputs(gateNeededKw + ADMISSION_MARGIN_KW),
      }).kind).toBe('no_gap');
      expect(resolveCeilingShortfall({
        dev,
        inputs: shortfallInputs(gateNeededKw + ADMISSION_MARGIN_KW - 0.05),
      }).kind).toBe('gap');
    });
  });

  // Raw power suffices; it is promised to a device about to start. No kW is
  // honest (the gap would be the HOLDER's block), so the holder's NAME is
  // attached instead and the card names who it is waiting for.
  //
  // The reason CODE must stay `capacity`. `reservedForStart` — the honest code —
  // is in `RESTORE_ADMISSION_HOLD_REASON_CODES` and builds no actuation intent;
  // only the restore lane may switch to it, because only that lane knows the shed
  // has materialized (`planHeadroomReserve.test.ts` § "keeps asserting the floor
  // while the shed has not materialized" is the guard). This stage runs on every
  // shed device without that fact, so it changes the copy, not the code.
  it('names the reservation holder without changing the actuating reason code', () => {
    const [device] = normalize({
      devices: [heldDevice()],
      capacityAvailableKw: 2.0,
      headroomReserves: [{ deviceId: 'other', deviceName: 'Water heater', priority: 1, kw: 1.5 }],
    });
    expect(device?.reason).toEqual({
      code: 'capacity',
      reserveHolderName: 'Water heater',
    });
    // Mutually exclusive with the gap: no kW may ride along.
    expect(device?.reason).not.toHaveProperty('shortfallKw');
  });

  // The annotation must not outlive the arithmetic that produced it. A holder
  // carried from a reserve-blocked cycle would keep saying "Waiting so X can
  // start" after X's reservation ended — and because the card ladder reads the
  // holder before the gap, it would also HIDE the kW this cycle resolved.
  it('drops a carried holder once the reservation stops blocking', () => {
    const [device] = normalize({
      devices: [heldDevice({
        reason: { code: 'capacity', reserveHolderName: 'Water heater' },
      })],
      capacityAvailableKw: 0.5,
    });
    expect(device?.reason).toEqual({ code: 'capacity', shortfallKw: 1.2 });
    expect(device?.reason).not.toHaveProperty('reserveHolderName');
  });

  it('drops a carried holder when admission would now pass', () => {
    const [device] = normalize({
      devices: [heldDevice({
        reason: { code: 'capacity', reserveHolderName: 'Water heater' },
      })],
      capacityAvailableKw: 2.0,
    });
    expect(device?.reason).toEqual({ code: 'capacity' });
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
    expect(exempt?.reason).toEqual({ code: 'capacity' });
    expect(bound?.reason).toEqual({ code: 'capacity', shortfallKw: 1.6 });
  });

  // Prod repro (2026-08-02): pace 0.55 kW, draw 1.54 kW → available −0.99 kW,
  // restore pass never ran. Every held card must resolve a number now.
  it('gives every deep-hold device a number even when available power is negative', () => {
    const devices = normalize({
      devices: [1, 2, 3, 4, 5].map((n) => heldDevice({
        id: `held-${n}`,
        reason: { code: 'daily_budget' },
      })),
      capacityAvailableKw: 20.27 - 1.54,
      budgetAvailableKw: -0.99,
      softLimitSource: 'daily',
    });
    for (const device of devices) {
      // gap = 0.25 − (−0.99 − 1.2 − 0.25) = 2.69 → 2.7 kW on the display grid.
      expect(device.reason).toEqual({ code: 'daily_budget', shortfallKw: 2.7 });
    }
  });

  describe('hourly-exhausted fold', () => {
    it('folds ceiling holds to hourlyBudget with no kW while the hour is spent', () => {
      const devices = normalize({
        devices: [
          heldDevice({ id: 'cap-dev', reason: { code: 'capacity' } }),
          heldDevice({ id: 'daily-dev', reason: { code: 'daily_budget', shortfallKw: 0.8 } }),
          heldDevice({ id: 'swap-dev', reason: { code: 'swapped_out', targetName: 'Water heater' } }),
        ],
        capacityAvailableKw: 0.5,
        hourlyBudgetExhausted: true,
      });
      expect(devices[0]?.reason).toEqual({ code: 'hourly_budget' });
      expect(devices[1]?.reason).toEqual({ code: 'hourly_budget' });
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
          reason: { code: 'hourly_budget' },
          budgetExempt: params.budgetExempt ?? false,
        })],
        capacityAvailableKw: 0.5,
        softLimitSource: params.softLimitSource,
        capacityBreached: params.capacityBreached ?? false,
      })[0];

      expect(roll({ softLimitSource: 'daily' })?.reason)
        .toEqual({ code: 'daily_budget', shortfallKw: 1.2 });
      expect(roll({ softLimitSource: 'daily', capacityBreached: true })?.reason)
        .toEqual({ code: 'capacity', shortfallKw: 1.2 });
      // Per-axis admission evaluates an exempt candidate on capacity, so its
      // hold is a capacity hold — never a budget label next to a "Budget exempt" chip.
      expect(roll({ softLimitSource: 'daily', budgetExempt: true })?.reason)
        .toEqual({ code: 'capacity', shortfallKw: 1.2 });
      expect(roll({ softLimitSource: 'capacity' })?.reason)
        .toEqual({ code: 'capacity', shortfallKw: 1.2 });
    });
  });
});

describe('finalizePlanDevices', () => {
  it('requires finalized devices to carry a structured reason contract', () => {
    const finalized = finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
    })]);

    expect(finalized.planDevices[0]?.reason.code).toBe('keep');
  });

  it('throws in tests when a final reason/state pair is not allowed', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: fixtureDeviceReason('restore low -> high (need 1.20kW)')!,
    })])).toThrow(/Invalid plan reason pair/);
  });

  it('allows legacy restore cooldown shed reasons that are still emitted by stay-off paths', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: fixtureDeviceReason('cooldown (restore, 30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows meter-settling shed reasons for blocked restore candidates', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: fixtureDeviceReason('meter settling (30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows legacy restore cooldown keep reasons that still surface during restore holds', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: fixtureDeviceReason('cooldown (restore, 30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows restore pending reasons for keep devices that are waiting on stepped confirmation', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: fixtureDeviceReason('restore pending (30s remaining)')!,
    })])).not.toThrow();
  });

  it('allows an awaitingSolarSurplus shed reason on a surplusOnly dump-load device', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      surplusOnly: true,
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus },
    })])).not.toThrow();
  });

  it('throws when an awaitingSolarSurplus reason rides a device WITHOUT the surplusOnly posture', () => {
    // Cross-field invariant: the reason mis-attributes the starvation-pause
    // classification if it appears on a non-dump-load device.
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus },
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
          reason: fixtureDeviceReason('shed due to daily budget')!,
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
        inStartupStabilization: false,
        restoreCooldownStartedAtMs: null,
        restoreCooldownTotalSec: null,
        getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
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
        reason: fixtureDeviceReason('swap pending')!,
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
      inStartupStabilization: false,
      restoreCooldownStartedAtMs: null,
      restoreCooldownTotalSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
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
      inStartupStabilization: false,
      restoreCooldownStartedAtMs: null,
      restoreCooldownTotalSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
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
      inStartupStabilization: false,
      restoreCooldownStartedAtMs: null,
      restoreCooldownTotalSec: null,
      guardInShortfall: true,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
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

  // `inShedWindow` is the OR of four causes (`restore/timing.ts`), three of them
  // timers. The hold lane used to collapse all four onto the `capacity`
  // fallback, so a thermostat at its shed floor claimed the power ceiling was
  // holding it while the binary device beside it — same cycle, same timer —
  // correctly read the countdown. `capacity` then reaches the card as a kW gap
  // the owner is invited to close, and the admission arithmetic finds none,
  // leaving the bare "Waiting to resume".
  describe('names the timing cause instead of the power ceiling', () => {
    const COOLDOWN_STARTED_AT_MS = Date.UTC(2026, 0, 1, 11, 59, 15);

    type HoldTimingOverride = Partial<Pick<
      Parameters<typeof applyShedTemperatureHold>[0],
      'inShedWindow' | 'inCooldown' | 'activeOvershoot' | 'inStartupStabilization'
      | 'holdDuringRestoreCooldown' | 'shedCooldownRemainingSec'
    >>;

    const runHold = (params: {
      timing?: HoldTimingOverride;
      shedReasons?: Map<string, DevicePlanDevice['reason']>;
      lastControlledMs?: number;
      // What the DEVICE reports. Defaults to the shed floor; raise it to model a
      // shed that has not materialized.
      currentTarget?: number;
    } = {}) => {
      const state = createPlanEngineState();
      state.lastPlannedShedIds.add('dev-temp');
      if (params.lastControlledMs !== undefined) {
        state.lastDeviceControlledMs['dev-temp'] = params.lastControlledMs;
      }
      return applyShedTemperatureHold({
        planDevices: [withBinaryOn(buildPlanDevice({
          id: 'dev-temp',
          name: 'Thermostat',
          currentState: 'keep',
          plannedState: 'shed',
          currentTarget: params.currentTarget ?? 16,
          plannedTarget: 16,
          shedAction: 'set_temperature',
          shedTemperature: 16,
          reason: { code: PLAN_REASON_CODES.capacity },
        }), true)],
        state,
        shedReasons: params.shedReasons ?? new Map(),
        inShedWindow: true,
        inCooldown: false,
        activeOvershoot: false,
        inStartupStabilization: false,
        availableHeadroom: 0,
        restoredOneThisCycle: false,
        restoredThisCycle: new Set(),
        shedCooldownRemainingSec: null,
        holdDuringRestoreCooldown: false,
        restoreCooldownSeconds: 45,
        restoreCooldownRemainingSec: 45,
        restoreCooldownStartedAtMs: COOLDOWN_STARTED_AT_MS,
        restoreCooldownTotalSec: 60,
        getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
        ...params.timing,
      });
    };

    it('reads the restore cooldown countdown, not the hard cap', () => {
      const result = runHold({ timing: { holdDuringRestoreCooldown: true } });

      expect(result.planDevices[0]?.reason).toEqual({
        code: PLAN_REASON_CODES.cooldownRestore,
        remainingSec: 45,
        countdownStartedAtMs: COOLDOWN_STARTED_AT_MS,
        countdownTotalSec: 60,
      });
      expect(plannedTargetOf(result.planDevices[0])).toBe(16);
    });

    // `cooldownRestore` is in `RESTORE_ADMISSION_HOLD_REASON_CODES`, so
    // `buildExecutableTargetIntent` builds NO write for a device carrying it.
    // Harmless once the device sits at its floor — there is nothing left to
    // write — but fatal while the shed is still in flight: the thermostat would
    // draw unchecked for the whole 60–300 s cooldown. Asserting `plannedTarget`
    // alone does not catch that; it is the plan's intent, not the executor's.
    it('keeps building the floor write while the shed has not materialized', () => {
      const inFlight = runHold({ timing: { holdDuringRestoreCooldown: true }, currentTarget: 22 });
      const [device] = inFlight.planDevices;

      expect(device?.reason.code).toBe(PLAN_REASON_CODES.capacity);
      expect(device && buildExecutableTargetIntent(device)).toMatchObject({
        desired: 16,
        purpose: 'shed_temperature',
      });

      // …and once the floor IS observed, suppressing the write costs nothing,
      // so the honest countdown wins.
      const settled = runHold({ timing: { holdDuringRestoreCooldown: true } });
      expect(settled.planDevices[0]?.reason.code).toBe(PLAN_REASON_CODES.cooldownRestore);
    });

    it('reads startup stabilization for a device PELS has controlled', () => {
      const result = runHold({
        timing: { inStartupStabilization: true },
        lastControlledMs: Date.UTC(2026, 0, 1, 11, 0, 0),
      });

      expect(result.planDevices[0]?.reason.code).toBe(PLAN_REASON_CODES.startupStabilization);
    });

    // The ladder answers `null` here — "PELS has never controlled this device,
    // claim nothing". The binary lane turns that into the no-actuation neutral
    // hold; this lane is still writing the shed floor, so it keeps its own
    // reason rather than pairing an actuating hold with a no-claim label.
    it('keeps the base reason during startup for a device PELS has never controlled', () => {
      const result = runHold({
        timing: { inStartupStabilization: true },
      });

      expect(result.planDevices[0]?.reason.code).toBe(PLAN_REASON_CODES.capacity);
      expect(plannedTargetOf(result.planDevices[0])).toBe(16);
    });

    it('leaves a fresh shed decision alone', () => {
      const result = runHold({
        timing: { holdDuringRestoreCooldown: true },
        shedReasons: new Map([['dev-temp', { code: PLAN_REASON_CODES.hourlyBudget, detail: null }]]),
      });

      expect(result.planDevices[0]?.reason.code).toBe(PLAN_REASON_CODES.hourlyBudget);
    });

    // The ceiling branch of the same OR: over pace, `capacity` IS the honest
    // cause, and the shared ladder hands the caller's own reason back.
    it('still names the ceiling while the house is over pace', () => {
      const result = runHold({ timing: { activeOvershoot: true } });

      expect(result.planDevices[0]?.reason.code).toBe(PLAN_REASON_CODES.capacity);
    });
  });
});
