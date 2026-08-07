import { describe, it, expect } from 'vitest';
import {
  buildCeilingShortfallInputs,
  resolveCeilingShortfall,
} from '../../lib/plan/planReasonShortfall';
import { buildPlanDevice } from '../utils/planTestUtils';

// The uniform per-cycle admission gap for ceiling-held cards. The arithmetic
// must be EXACTLY the restore gates' inequality — gap = FLOOR − (available −
// needed − RESERVE), FLOOR = RESERVE = 0.25 kW — ceiled to the 0.1 kW display
// step, or the card would name a number that does not admit the device.
//
// Fixtures pin the need via `residualKw.restore` (producer-resolved path of
// `estimateRestorePower`): power 1.0 kW + restore buffer
// clamp(0.2, 0.6, 0.1·power + 0.1) = 0.2 kW → needed 1.2 kW.
const heldDevice = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
  id: 'held-dev',
  plannedState: 'shed',
  priority: 3,
  residualKw: { shed: 0, restore: { kw: 1.0, source: 'planning' } },
  ...overrides,
});

const inputs = (params: {
  capacityAvailableKw: number;
  budgetAvailableKw?: number | null;
  headroomReserves?: readonly { deviceId: string; deviceName: string; priority: number; kw: number }[];
  onDevices?: readonly ReturnType<typeof buildPlanDevice>[];
  swappedOutFor?: ReadonlyMap<string, string>;
  restoredThisCycle?: ReadonlySet<string>;
}) => buildCeilingShortfallInputs({
  ledgerAxes: {
    capacityAvailableKw: params.capacityAvailableKw,
    budgetAvailableKw: params.budgetAvailableKw ?? null,
  },
  headroomReserves: params.headroomReserves ?? [],
  onDevices: params.onDevices ?? [],
  swappedOutFor: params.swappedOutFor ?? new Map(),
  restoredThisCycle: params.restoredThisCycle ?? new Set(),
});

// Unwraps to the kW for the arithmetic cases below. The two no-number outcomes
// (`blocked_by_reserve` vs `no_gap`) are asserted on `kind` directly rather than
// through this helper: distinguishing them is the whole reason the resolver
// returns a discriminated result instead of `number | null`.
const gapKw = (params: Parameters<typeof resolveCeilingShortfall>[0]): number | null => {
  const resolution = resolveCeilingShortfall(params);
  return resolution.kind === 'gap' ? resolution.shortfallKw : null;
};

describe('resolveCeilingShortfall', () => {
  it('computes the admission gap FLOOR − (available − needed − RESERVE)', () => {
    // available 0.5, needed 1.2 → postReserveMargin = 0.5 − 1.2 − 0.25 = −0.95
    // → gap = 0.25 − (−0.95) = 1.2 kW, exact on the display grid.
    expect(gapKw({
      dev: heldDevice(),
      inputs: inputs({ capacityAvailableKw: 0.5 }),
    })).toBe(1.2);
  });

  it('ceils to the 0.1 kW display step, never floors', () => {
    // available 1.16 → gap = 0.25 − (1.16 − 1.2 − 0.25) = 0.54 → renders 0.6:
    // rounding down would invite freeing 0.5 kW and still being short.
    expect(gapKw({
      dev: heldDevice(),
      inputs: inputs({ capacityAvailableKw: 1.16 }),
    })).toBe(0.6);
  });

  it('reports no_gap when admission would pass — the hold is not a power gap', () => {
    // available 2.0 → postReserveMargin 0.55 ≥ 0.25 floor.
    expect(resolveCeilingShortfall({
      dev: heldDevice(),
      inputs: inputs({ capacityAvailableKw: 2.0 }),
    })).toEqual({ kind: 'no_gap' });
  });

  // The reserve carve-out: raw power suffices but is promised to a more
  // important device about to start. A gap "through" the reservation would state
  // the holder's block as this device's number, so no kW here — but the outcome
  // must stay DISTINGUISHABLE from `no_gap`, because the caller writes a
  // different line for it (the holder's name, `finalizeCeilingReason`). Merging
  // the two into a bare `null` is what left those cards on the generic waiting
  // line whenever the restore lane had not run.
  it('reports blocked_by_reserve, not no_gap, when only a startup reservation blocks', () => {
    expect(resolveCeilingShortfall({
      dev: heldDevice(),
      inputs: inputs({
        capacityAvailableKw: 2.0,
        headroomReserves: [{ deviceId: 'other', deviceName: 'Water heater', priority: 1, kw: 1.5 }],
      }),
    })).toEqual({ kind: 'blocked_by_reserve' });
  });

  // Per-axis discipline (`RestoreHeadroomLedger.availableFor`): a budget-exempt
  // device admits on the CAPACITY axis only, so a spent budget axis must not
  // manufacture a gap for it — while a non-exempt sibling reads min(cap, budget).
  it('reads the capacity axis for a budget-exempt device and the min for others', () => {
    const axes = { capacityAvailableKw: 2.0, budgetAvailableKw: 0.1 };
    expect(gapKw({
      dev: heldDevice({ budgetExempt: true }),
      inputs: inputs(axes),
    })).toBeNull();
    // gap = 0.25 − (0.1 − 1.2 − 0.25) = 1.6 kW
    expect(gapKw({
      dev: heldDevice({ budgetExempt: false }),
      inputs: inputs(axes),
    })).toBe(1.6);
  });

  // Swap-aware gap (user ruling 2026-08-02): PELS can free a viable
  // lower-priority device's draw on its own, so the honest "more needed" is
  // `needed − victimDraw − available + margins` (with the 0.3 kW swap reserve
  // folded in), mirroring `buildSwapCandidates` exactly.
  describe('folds swap relief into the gap', () => {
    const victim = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
      id: 'victim',
      plannedState: 'keep',
      priority: 9,
      currentOn: true,
      measuredPowerKw: 1.0,
      ...overrides,
    });

    it('shrinks the gap by the victim draw plus the swap reserve', () => {
      // Plain gap: 0.25 − (0.5 − 1.2 − 0.25) = 1.2. Swap potential:
      // 0.5 + 1.0 = 1.5 → effective 1.2 after the 0.3 swap reserve →
      // post = 1.2 − 1.2 − 0.25 = −0.25 → gap = 0.5 kW.
      expect(gapKw({
        dev: heldDevice(),
        inputs: inputs({ capacityAvailableKw: 0.5, onDevices: [victim()] }),
      })).toBe(0.5);
    });

    it('returns null when the swap alone would admit the device', () => {
      expect(gapKw({
        dev: heldDevice(),
        inputs: inputs({ capacityAvailableKw: 0.5, onDevices: [victim({ measuredPowerKw: 2.5 })] }),
      })).toBeNull();
    });

    it('ignores a HIGHER-priority running device — it cannot be swapped out', () => {
      expect(gapKw({
        dev: heldDevice(),
        inputs: inputs({ capacityAvailableKw: 0.5, onDevices: [victim({ priority: 1 })] }),
      })).toBe(1.2);
    });

    it('ignores a budget-exempt victim for a non-exempt device (axis mismatch rule)', () => {
      expect(gapKw({
        dev: heldDevice({ budgetExempt: false }),
        inputs: inputs({ capacityAvailableKw: 0.5, onDevices: [victim({ budgetExempt: true })] }),
      })).toBe(1.2);
    });
  });

  // The invariant the comparable-exclusion design leans on: whatever comes out
  // of this resolver is already on the display grid — an un-ceiled float must
  // never be stored on a reason.
  it('only ever returns multiples of 0.1 kW', () => {
    for (const availableKw of [0.03, 0.51, 0.777, 1.049, 1.16]) {
      const gap = gapKw({
        dev: heldDevice(),
        inputs: inputs({ capacityAvailableKw: availableKw }),
      });
      expect(gap).not.toBeNull();
      expect(Math.round((gap as number) * 10) / 10).toBeCloseTo(gap as number, 10);
    }
  });
});
