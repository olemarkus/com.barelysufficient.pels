import {
  isHoldReasonCode,
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolvePlanCardStatusChip,
  resolveRawPlanStateKind,
} from '../../shared-domain/src/planCardGrammar.ts';

describe('resolveIntentStateKind', () => {
  it('upgrades idle to held on a hold/wait reason', () => {
    expect(resolveIntentStateKind({
      kind: 'idle', reasonCode: 'insufficient_headroom', starved: false,
    })).toBe('held');
    expect(resolveIntentStateKind({
      kind: 'idle', reasonCode: 'awaiting_solar_surplus', starved: false,
    })).toBe('held');
    // Countdown holds that gate a resume on available power are held too.
    expect(resolveIntentStateKind({
      kind: 'idle', reasonCode: 'headroom_cooldown', starved: false,
    })).toBe('held');
  });

  it('upgrades idle to held when starved even without a hold reason code', () => {
    expect(resolveIntentStateKind({ kind: 'idle', reasonCode: 'none', starved: true })).toBe('held');
  });

  it('maps an idle restore/settling countdown to resuming, winning over latched starvation', () => {
    expect(resolveIntentStateKind({
      kind: 'idle', reasonCode: 'cooldown_restore', starved: false,
    })).toBe('resuming');
    expect(resolveIntentStateKind({
      kind: 'idle', reasonCode: 'restore_pending', starved: true,
    })).toBe('resuming');
  });

  it('leaves genuinely idle and non-idle kinds alone', () => {
    expect(resolveIntentStateKind({ kind: 'idle', reasonCode: 'none', starved: false })).toBe('idle');
    expect(resolveIntentStateKind({ kind: 'active', reasonCode: 'insufficient_headroom', starved: true })).toBe('active');
    expect(resolveIntentStateKind({ kind: 'manual', reasonCode: 'capacity', starved: false })).toBe('manual');
  });
});

describe('resolveDisplayStateKind — simulation renders the factual state', () => {
  it('collapses held/resuming to the factual on/off state under simulation', () => {
    expect(resolveDisplayStateKind({
      kind: 'held', dryRun: true, currentState: 'on', reasonCode: 'capacity', starved: false,
    })).toBe('active');
    expect(resolveDisplayStateKind({
      kind: 'held', dryRun: true, currentState: 'off', reasonCode: 'capacity', starved: false,
    })).toBe('idle');
    expect(resolveDisplayStateKind({
      kind: 'resuming', dryRun: true, currentState: 'off', reasonCode: 'none', starved: false,
    })).toBe('idle');
  });

  it('treats a target-only device (not_applicable) as factually active under simulation', () => {
    expect(resolveDisplayStateKind({
      kind: 'held', dryRun: true, currentState: 'not_applicable', reasonCode: 'capacity', starved: false,
    })).toBe('active');
  });

  it('never fires the idle→held upgrade under simulation (nothing is held)', () => {
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: true, currentState: 'off', reasonCode: 'insufficient_headroom', starved: true,
    })).toBe('idle');
  });

  it('passes non-acted kinds through untouched in both modes', () => {
    for (const dryRun of [false, true]) {
      expect(resolveDisplayStateKind({
        kind: 'unavailable', dryRun, currentState: 'off', reasonCode: 'none', starved: false,
      })).toBe('unavailable');
      expect(resolveDisplayStateKind({
        kind: 'manual', dryRun, currentState: 'on', reasonCode: 'none', starved: false,
      })).toBe('manual');
    }
  });
});

describe('resolvePlanCardStatusChip — single-chip ladder', () => {
  const base = {
    displayKind: 'held' as const,
    dryRun: false,
    starvation: undefined,
    rescueEligible: false,
    temperatureBoostActive: false,
    evBoostActive: false,
    budgetExempt: false,
  };
  const budgetStarved = { isStarved: true, cause: 'budget' as const, accumulatedMs: 60_000, startedAtMs: 0 };

  it('rescue action wins the ladder, but never under simulation', () => {
    expect(resolvePlanCardStatusChip({
      ...base, rescueEligible: true, starvation: budgetStarved,
    })).toEqual({ type: 'rescue' });
    const simChip = resolvePlanCardStatusChip({
      ...base, rescueEligible: true, starvation: budgetStarved, dryRun: true, displayKind: 'active',
    });
    expect(simChip?.type).not.toBe('rescue');
  });

  it('shows the starvation badge only while the card reads held', () => {
    const held = resolvePlanCardStatusChip({ ...base, starvation: budgetStarved });
    expect(held).toMatchObject({ type: 'status', label: 'Budget limited', tone: 'info' });
    // Recovery latch: device running again, starvation still flagged — no badge.
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', starvation: budgetStarved,
    })).toBeNull();
  });

  it('falls through boost then always-on, one chip max', () => {
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', temperatureBoostActive: true, budgetExempt: true,
    })).toMatchObject({ type: 'status', label: 'Boost' });
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', evBoostActive: true,
    })).toMatchObject({ type: 'status', label: 'Boost' });
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', budgetExempt: true,
    })).toMatchObject({ type: 'status', label: 'Always on' });
    expect(resolvePlanCardStatusChip({ ...base, displayKind: 'active' })).toBeNull();
  });
});

describe('isHoldReasonCode', () => {
  it('covers the waiting + limited families and the posture holds', () => {
    for (const code of [
      'insufficient_headroom', 'shortfall', 'waiting_for_other_devices', 'restore_throttled',
      'swap_pending', 'swapped_out', 'capacity', 'hourly_budget', 'daily_budget',
      'shed_invariant', 'deferred_objective_avoid', 'awaiting_solar_surplus',
      'headroom_cooldown', 'cooldown_shedding',
    ]) {
      expect(isHoldReasonCode(code)).toBe(true);
    }
    expect(isHoldReasonCode('none')).toBe(false);
    expect(isHoldReasonCode(undefined)).toBe(false);
  });
});

describe('resolveRawPlanStateKind', () => {
  it('prefers a valid producer-resolved stateKind over recomputation', () => {
    expect(resolveRawPlanStateKind({
      currentState: 'on', plannedState: 'keep', stateKind: 'held',
    } as never)).toBe('held');
  });

  it('falls back to a fresh resolution for a missing or junk stateKind', () => {
    expect(resolveRawPlanStateKind({
      currentState: 'on', plannedState: 'shed', stateKind: 'bogus',
    } as never)).toBe('held');
    expect(resolveRawPlanStateKind({
      currentState: 'on', plannedState: 'keep',
    } as never)).toBe('active');
  });
});
