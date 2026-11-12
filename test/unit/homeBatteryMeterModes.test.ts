// A meter-following battery's mode for each command, and its claim read
// against PELS's record: engaged in any of PELS's modes, any mode it held
// before PELS recorded for the hand-back, and a mode outside PELS's read as a
// takeover once the confirmation window is over.
import { isPelsClaimValue, meterModeFor } from '../../lib/ports/homeBatteryResponse';
import {
  ClaimWriteLog, isClaimEngaged, reportsMeterMode, resolveValueToRecord, toOwnModeGridCharge, type SetpointBatteryRead,
} from '../../lib/battery/batteryClaimStanding';
import type { BatteryClaimRecord } from '../../lib/battery/batteryClaimStore';
import type { HomeBatteryMeterModes } from '../../packages/contracts/src/types';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';

const MODES: HomeBatteryMeterModes = {
  discharge: 'zero_discharge_only', hold: 'standby', chargeSurplus: 'zero_charge_only', chargeGrid: 'to_full',
  gridChargeW: 800, gridChargingModes: ['to_full', 'predictive'],
};
const VALUES = ['zero', 'zero_charge_only', 'zero_discharge_only', 'standby', 'to_full', 'predictive'];

const battery = (value: string, observedAtMs = 0): SetpointBatteryRead => ({
  kind: 'setpoint',
  surface: {
    kind: 'setpoint',
    response: { kind: 'follows_meter', modes: MODES },
    claim: { capabilityId: 'battery_group_charge_mode', values: VALUES, rejection: 'unanswered' },
    range: { minW: -800, maxW: 800, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  },
  claim: { value, observedAtMs },
  keepAliveFor: () => ({ kind: 'none' }),
});

describe('meter-following battery modes', () => {
  it('maps each setpoint to its mode: discharge, hold, surplus charge, and grid charge only at the full size', () => {
    expect(meterModeFor(MODES, -1)).toBe('zero_discharge_only');
    expect(meterModeFor(MODES, -800)).toBe('zero_discharge_only');
    expect(meterModeFor(MODES, 0)).toBe('standby');
    expect(meterModeFor(MODES, 1)).toBe('zero_charge_only');
    expect(meterModeFor(MODES, 799)).toBe('zero_charge_only');
    expect(meterModeFor(MODES, 800)).toBe('to_full');
  });

  it('reads PELS\'s four modes as PELS\'s claim values, and the battery\'s own modes as not', () => {
    const response = { kind: 'follows_meter', modes: MODES } as const;
    expect(['zero_discharge_only', 'standby', 'zero_charge_only', 'to_full'].every((v) => isPelsClaimValue(response, v)))
      .toBe(true);
    expect(isPelsClaimValue(response, 'zero')).toBe(false);
    expect(isPelsClaimValue(response, 'predictive')).toBe(false);
  });

  it('is engaged in any of PELS\'s modes, and reports a command only in the mode it maps to', () => {
    expect(isClaimEngaged(battery('standby'))).toBe(true);
    expect(isClaimEngaged(battery('zero'))).toBe(false);
    expect(reportsMeterMode(battery('zero_discharge_only'), -500)).toBe(true);
    expect(reportsMeterMode(battery('standby'), -500)).toBe(false);
  });

  it('records the mode it holds before the first claim, a standby the owner left included', () => {
    expect(resolveValueToRecord(battery('zero'))).toMatchObject({ kind: 'claim_capability', claim: { value: 'zero' } });
    expect(resolveValueToRecord(battery('predictive'))).toMatchObject({ claim: { value: 'predictive' } });
    expect(resolveValueToRecord(battery('standby'))).toMatchObject({ claim: { value: 'standby' } });
  });

  it('reads a mode outside PELS\'s after its last write as contested, then as taken over', () => {
    const log = new ClaimWriteLog();
    const record: BatteryClaimRecord = {
      kind: 'claim_capability', capabilityId: 'battery_group_charge_mode', previousValue: 'zero', claimedAtMs: 0,
    };
    log.noteWrite('p1', 1_000);
    expect(log.readStanding('p1', record, battery('standby', 2_000), 2_000)).toBe('held');
    expect(log.readStanding('p1', record, battery('zero', 2_000), 2_000)).toBe('contested');
    expect(log.readStanding('p1', record, battery('zero', 2_000), 1_000 + CONTROL_COMMAND_CONFIRMATION_MS))
      .toBe('taken_over');
  });

  it('declares what its own mode takes from the grid by the mode it is handed back to', () => {
    const recorded = (previousValue: string): BatteryClaimRecord => ({
      kind: 'claim_capability', capabilityId: 'battery_group_charge_mode', previousValue, claimedAtMs: 0,
    });
    // Held in PELS's discharge mode, it is handed back to the mode it had before.
    for (const ownMode of ['zero', 'standby', 'zero_charge_only', 'zero_discharge_only']) {
      expect(toOwnModeGridCharge(battery('zero_discharge_only'), recorded(ownMode))).toEqual({ kind: 'declared', chargeW: 0 });
    }
    for (const ownMode of ['to_full', 'predictive']) {
      expect(toOwnModeGridCharge(battery('zero_discharge_only'), recorded(ownMode))).toEqual({ kind: 'declared', chargeW: 800 });
    }
    // Not held: the mode it reports now is its own.
    expect(toOwnModeGridCharge(battery('predictive'), undefined)).toEqual({ kind: 'declared', chargeW: 800 });
    expect(toOwnModeGridCharge(battery('zero'), undefined)).toEqual({ kind: 'declared', chargeW: 0 });
  });
});
