import { describe, expect, it } from 'vitest';
import {
  accountForAvailablePowerDevices, yieldAvailablePower,
} from '../../lib/plan/restore/availablePowerDevices';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import { buildExecutableDeviceIntent } from '../../lib/plan/planExecutionProjection';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice } from '../utils/planTestUtils';

const ledgerWithCapacity = (kw: number) => buildRestoreHeadroomLedger({
  capacity: { kind: 'on', kw },
  grid: { kind: 'off' },
  budget: { kind: 'off' },
  phase: { kind: 'off' },
});

describe('energized loads using available power', () => {
  it('accounts for an energized idle relay until it reports off', () => {
    const relay = buildPlanDevice({
      id: 'relay', currentState: 'on', currentDrawKw: 0.2, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'unknown' },
    });
    const devices = new Map<string, typeof relay>([[relay.id, relay]]);
    const ledger = ledgerWithCapacity(1);
    accountForAvailablePowerDevices(devices, ledger, () => 0.2);

    expect(devices.get(relay.id)?.plannedState).toBe('shed');
    expect(ledger.availableFor(relay)).toBeCloseTo(-0.8);

    const nextLedger = ledgerWithCapacity(1);
    const observedOff = buildPlanDevice({
      id: relay.id, currentState: 'off', currentDrawKw: 0, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'unknown' },
    });
    accountForAvailablePowerDevices(new Map([[relay.id, observedOff]]), nextLedger, () => 0);
    expect(nextLedger.availableFor(relay)).toBe(1);
  });

  it('does not credit a rebound the whole-home reading has yet to see', () => {
    const relay = buildPlanDevice({
      id: 'relay', currentState: 'on', currentDrawKw: 2, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'unknown' },
    });
    const devices = new Map([[relay.id, relay]]);
    const ledger = ledgerWithCapacity(3);
    accountForAvailablePowerDevices(devices, ledger, () => 0);
    expect(ledger.availableFor(relay)).toBe(1);
  });

  it('does not credit whole-home draw against an independent phase reading', () => {
    const relay = buildPlanDevice({
      id: 'relay', currentState: 'on', currentDrawKw: 2, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'single', phase: 'L1' },
    });
    const devices = new Map([[relay.id, relay]]);
    const ledger = buildRestoreHeadroomLedger({
      capacity: { kind: 'on', kw: 4 },
      grid: { kind: 'off' },
      budget: { kind: 'off' },
      phase: { kind: 'on', roomKw: { L1: 3, L2: 3, L3: 3 } },
    });
    accountForAvailablePowerDevices(devices, ledger, () => 2);
    expect(ledger.axes().capacity).toEqual({ kind: 'on', kw: 4 });
    expect(ledger.availableFor(relay)).toBe(1);
  });

  it.each([
    [2, 2, 'keep'],
    [1, 1, 'shed'],
    [2, 0, 'shed'],
  ] as const)('reacts to possible new phase draw with %s kW drawn and %s kW covered', (draw, covered, state) => {
    const relay = buildPlanDevice({
      id: 'relay', currentState: 'on', currentDrawKw: draw, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'single', phase: 'L1' },
    });
    const devices = new Map([[relay.id, relay]]);
    const ledger = buildRestoreHeadroomLedger({
      capacity: { kind: 'on', kw: 4 },
      grid: { kind: 'off' },
      budget: { kind: 'off' },
      phase: { kind: 'on', roomKw: { L1: 0.5, L2: 3, L3: 3 } },
    });
    accountForAvailablePowerDevices(devices, ledger, () => covered);
    expect(devices.get(relay.id)?.plannedState).toBe(state);
    expect(ledger.availableFor(relay)).toBe(-1.5);
  });

  it('asks an idle relay to yield without giving its watts to a waiting load in the same cycle', () => {
    const relay = buildPlanDevice({
      id: 'relay', currentState: 'on', currentDrawKw: 0, expectedPowerKw: 2, usesAvailablePower: true,
      phaseFootprint: { kind: 'unknown' },
    });
    const waiting = buildPlanDevice({
      id: 'booked', currentState: 'off', currentDrawKw: 0, expectedPowerKw: 2, plannedState: 'shed',
      phaseFootprint: { kind: 'single', phase: 'L1' },
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom, needKw: 2.3, availableKw: 1,
        admissionMarginKw: -1.3, penaltyExtraKw: null, swapReserveKw: null, effectiveAvailableKw: null,
      },
    });
    const devices = new Map([[relay.id, relay], [waiting.id, waiting]]);
    const ledger = buildRestoreHeadroomLedger({
      capacity: { kind: 'off' },
      grid: { kind: 'off' },
      budget: { kind: 'off' },
      phase: { kind: 'on', roomKw: { L1: 3, L2: 3, L3: 3 } },
    });
    const energized = accountForAvailablePowerDevices(devices, ledger, () => 0);

    expect(ledger.availableFor(waiting)).toBe(1);
    yieldAvailablePower(devices, energized, ledger);

    const limitedRelay = devices.get(relay.id)!;
    expect(limitedRelay.plannedState).toBe('shed');
    expect(buildExecutableDeviceIntent(limitedRelay)).toMatchObject({ binary: { desiredOn: false } });
    expect(devices.get(waiting.id)?.plannedState).toBe('shed');
    expect(ledger.availableFor(waiting)).toBe(1);
  });
});
