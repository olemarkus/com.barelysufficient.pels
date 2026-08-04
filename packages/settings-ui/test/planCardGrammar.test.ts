import {
  displayStateLabel,
  displayStateTone,
  isHoldReasonCode,
  isDimmedDisplayStateKind,
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolvePlanCardStatusChip,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
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
    })).toBe('off');
    expect(resolveDisplayStateKind({
      kind: 'resuming', dryRun: true, currentState: 'off', reasonCode: 'none', starved: false,
    })).toBe('off');
  });

  it('treats a target-only device (not_applicable) as factually active under simulation', () => {
    expect(resolveDisplayStateKind({
      kind: 'held', dryRun: true, currentState: 'not_applicable', reasonCode: 'capacity', starved: false,
    })).toBe('active');
  });

  it('collapses a SATISFIED target-only device to idle under simulation, not active', () => {
    // The factual collapse must not resurrect "Running" on a satisfied 0-draw
    // device that real mode reads as Idle — the caller threads the resolved
    // `isSatisfiedTargetOnlyDevice` verdict in.
    expect(resolveDisplayStateKind({
      kind: 'held',
      dryRun: true,
      currentState: 'not_applicable',
      reasonCode: 'capacity',
      starved: false,
      satisfiedTargetOnly: true,
    })).toBe('idle');
  });

  it('never fires the idle→held upgrade under simulation (nothing is held)', () => {
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: true, currentState: 'off', reasonCode: 'insufficient_headroom', starved: true,
    })).toBe('off');
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

describe('resolveDisplayStateKind — observed off is distinct from idle', () => {
  it('keeps an available on-device idle but shows affirmative off evidence as Off', () => {
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: false, currentState: 'on', reasonCode: 'none', starved: false,
    })).toBe('idle');
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: false, currentState: 'off', reasonCode: 'none', starved: false,
    })).toBe('off');
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: false, currentState: '  OFF ', reasonCode: 'none', starved: false,
    })).toBe('off');
  });

  it('keeps higher-priority intent states above observed Off', () => {
    for (const kind of ['held', 'resuming', 'manual', 'unavailable'] as const) {
      expect(resolveDisplayStateKind({
        kind, dryRun: false, currentState: 'off', reasonCode: 'none', starved: false,
      })).toBe(kind);
    }
  });

  it('does not infer Off from unknown or target-only state', () => {
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: false, currentState: 'unknown', reasonCode: 'none', starved: false,
    })).toBe('idle');
    expect(resolveDisplayStateKind({
      kind: 'idle', dryRun: false, currentState: 'not_applicable', reasonCode: 'none', starved: false,
    })).toBe('idle');
  });

  it('uses the quiet idle presentation for Off', () => {
    expect(displayStateLabel('off')).toBe('Off');
    expect(displayStateTone('off')).toBe('idle');
    expect(isDimmedDisplayStateKind('off')).toBe(true);
  });

  it('shows external-off guidance only beside the Off display state', () => {
    expect(shouldDisplayExternalOffReason('off', 'external_off_hold')).toBe(true);
    for (const kind of ['idle', 'held', 'resuming', 'manual', 'unavailable'] as const) {
      expect(shouldDisplayExternalOffReason(kind, 'external_off_hold')).toBe(false);
    }
    expect(shouldDisplayExternalOffReason('off', 'none')).toBe(false);
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
  const heldBackStarved = { isStarved: true, accumulatedMs: 60_000, startedAtMs: 0 };

  it('rescue action wins the ladder, but never under simulation', () => {
    expect(resolvePlanCardStatusChip({
      ...base, rescueEligible: true, starvation: heldBackStarved,
    })).toEqual({ type: 'rescue' });
    const simChip = resolvePlanCardStatusChip({
      ...base, rescueEligible: true, starvation: heldBackStarved, dryRun: true, displayKind: 'active',
    });
    expect(simChip?.type).not.toBe('rescue');
  });

  it('shows the starvation badge only while the card reads held', () => {
    const held = resolvePlanCardStatusChip({ ...base, starvation: heldBackStarved });
    expect(held).toMatchObject({ type: 'status', label: 'Held back', tone: 'warn' });
    // Recovery latch: device running again, starvation still flagged — no badge.
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', starvation: heldBackStarved,
    })).toBeNull();
  });

  it('falls through boost then budget-exempt, one chip max', () => {
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', temperatureBoostActive: true, budgetExempt: true,
    })).toMatchObject({ type: 'status', label: 'Boost' });
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', evBoostActive: true,
    })).toMatchObject({ type: 'status', label: 'Boost' });
    expect(resolvePlanCardStatusChip({
      ...base, displayKind: 'active', budgetExempt: true,
    })).toMatchObject({ type: 'status', label: 'Budget exempt' });
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
