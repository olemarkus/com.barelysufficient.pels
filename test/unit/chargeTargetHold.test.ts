import { describe, expect, it } from 'vitest';
import {
  isChargeTargetHoldShed,
  resolveChargeTargetHold,
} from '../../lib/plan/shedding/chargeTargetHold';
import { projectChargeTargetHold } from '../../lib/planInput/chargeTargetHold';
import type { ToPlanDeviceInput } from '../../lib/planInput/planInputDeviceTypes';
import { applyDeferredAdmissionToInput } from '../../lib/objectives/deferredObjectives/admission';
import type { DeferredAdmissionDecision } from '../../lib/objectives/deferredObjectives/admission';
import { getInactiveReason } from '../../lib/plan/restore/devices';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import type {
  ChargeTargetHold,
  DeviceControlPosture,
} from '../../packages/planner-types/src/planInputDevice';
import type { DeviceStateOfChargeSnapshot, EvChargeTargetConfig } from '../../packages/contracts/src/types';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  formatDeviceReason,
  formatDeviceReasonUserFacing,
} from '../../packages/shared-domain/src/planReasonFormatting';
import { buildComparableDeviceReason } from '../../packages/shared-domain/src/planReasonComparable';
import { normalizeEvChargeTargetSettings } from '../../packages/shared-domain/src/settings/evChargeTarget';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { partialDouble } from '../helpers/partialDouble';

const TARGET: EvChargeTargetConfig = { targetPercent: 30, chargeBeforeLevelKnown: true };
const WAIT_FOR_LEVEL: EvChargeTargetConfig = { targetPercent: 30, chargeBeforeLevelKnown: false };
const AUTHORITY: DeviceControlPosture = { managed: true, commandAuthority: true };

const known = (percent: number): DeviceStateOfChargeSnapshot['level'] => (
  { kind: 'known', percent, observedAtMs: 1 }
);

/** The charger as the producer sees it: EV identity, a plug state, and maybe a level. */
const charger = (
  level: DeviceStateOfChargeSnapshot['level'] | null,
  evChargingState = 'plugged_in_charging',
): ToPlanDeviceInput => partialDouble<ToPlanDeviceInput>({
  id: 'charger',
  isEvCharger: true,
  evChargingState,
  ...(level ? { stateOfCharge: { level } } : {}),
} as Partial<ToPlanDeviceInput>);

describe('projectChargeTargetHold (producer)', () => {
  it('holds a charger whose known level is at the target', () => {
    expect(projectChargeTargetHold(TARGET, charger(known(30)), AUTHORITY))
      .toEqual({ kind: 'target_reached', targetPercent: 30 });
  });

  it('holds a charger whose known level is above the target', () => {
    expect(projectChargeTargetHold(TARGET, charger(known(55)), AUTHORITY))
      .toEqual({ kind: 'target_reached', targetPercent: 30 });
  });

  it('never holds at a 100% target, so a full car that still draws keeps the charger on', () => {
    const full: EvChargeTargetConfig = { targetPercent: 100, chargeBeforeLevelKnown: true };
    expect(projectChargeTargetHold(full, charger(known(100)), AUTHORITY))
      .toEqual({ kind: 'at_full_target', targetPercent: 100 });
  });

  it('does not hold a charger below its target, and names the target it is short of', () => {
    expect(projectChargeTargetHold(TARGET, charger(known(25)), AUTHORITY))
      .toEqual({ kind: 'below_target', targetPercent: 30 });
  });

  it('does not hold a charger with no target, and says it has none', () => {
    expect(projectChargeTargetHold(undefined, charger(known(90)), AUTHORITY)).toEqual({ kind: 'no_target' });
    // No car connected is still nothing at all, target or not.
    expect(projectChargeTargetHold(undefined, charger(null, 'plugged_out'), AUTHORITY)).toEqual({ kind: 'none' });
  });

  it('charges before the level is known by default, saying the level is unknown', () => {
    expect(projectChargeTargetHold(TARGET, charger({ kind: 'unavailable', reasonCode: 'not_reported' }), AUTHORITY))
      .toEqual({ kind: 'level_unknown' });
    expect(projectChargeTargetHold(TARGET, charger(null), AUTHORITY)).toEqual({ kind: 'level_unknown' });
  });

  it('waits for the level when the owner chose not to charge before it is known', () => {
    expect(projectChargeTargetHold(
      WAIT_FOR_LEVEL,
      charger({ kind: 'unavailable', reasonCode: 'not_reported' }),
      AUTHORITY,
    )).toEqual({ kind: 'awaiting_level' });
    // A charger that has never reported a level waits the same way.
    expect(projectChargeTargetHold(WAIT_FOR_LEVEL, charger(null), AUTHORITY)).toEqual({ kind: 'awaiting_level' });
  });

  it('does not hold a charger with no car connected', () => {
    expect(projectChargeTargetHold(
      WAIT_FOR_LEVEL,
      charger({ kind: 'unavailable', reasonCode: 'not_connected' }),
      AUTHORITY,
    )).toEqual({ kind: 'none' });
    expect(projectChargeTargetHold(WAIT_FOR_LEVEL, charger(null, 'plugged_out'), AUTHORITY))
      .toEqual({ kind: 'none' });
  });

  it('does not hold a charger PELS only watches', () => {
    expect(projectChargeTargetHold(TARGET, charger(known(80)), { managed: true, commandAuthority: false }))
      .toEqual({ kind: 'none' });
    expect(projectChargeTargetHold(TARGET, charger(known(80)), { managed: false, commandAuthority: false }))
      .toEqual({ kind: 'none' });
  });

  it('never holds a device that is not a charger', () => {
    const heater = partialDouble<ToPlanDeviceInput>({ id: 'heater', isEvCharger: false });
    expect(projectChargeTargetHold(WAIT_FOR_LEVEL, heater, AUTHORITY)).toEqual({ kind: 'none' });
  });
});

const planInput = (chargeTargetHold: ChargeTargetHold, lifted = false) => inputDevice({
  id: 'charger',
  name: 'Charger',
  isEvCharger: true,
  binaryCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
  controllable: true,
  managed: true,
  commandAuthority: true,
  chargeTargetHold,
  ...(lifted ? { chargeTargetHoldLifted: true as const } : {}),
});

describe('resolveChargeTargetHold (planner)', () => {
  it('holds a charger at its target and names the target', () => {
    const result = resolveChargeTargetHold([planInput({ kind: 'target_reached', targetPercent: 60 })]);
    expect([...result.holdIds]).toEqual(['charger']);
    expect(result.reasonById.get('charger'))
      .toEqual({ code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 60 });
  });

  it('holds a charger waiting for a level with a reason that carries nothing', () => {
    const result = resolveChargeTargetHold([planInput({ kind: 'awaiting_level' })]);
    expect(result.reasonById.get('charger')).toEqual({ code: PLAN_REASON_CODES.awaitingBatteryLevel });
  });

  it('holds nothing when the producer resolved no hold', () => {
    expect([...resolveChargeTargetHold([planInput({ kind: 'none' })]).holdIds]).toEqual([]);
  });

  it.each([
    { kind: 'below_target', targetPercent: 60 },
    { kind: 'at_full_target', targetPercent: 100 },
    { kind: 'no_target' },
    { kind: 'level_unknown' },
  ] as const)('holds nothing for a charger the target does not hold ($kind)', (hold) => {
    expect([...resolveChargeTargetHold([planInput(hold)]).holdIds]).toEqual([]);
  });

  it('holds nothing while a smart task lifts it', () => {
    const result = resolveChargeTargetHold([planInput({ kind: 'target_reached', targetPercent: 60 }, true)]);
    expect([...result.holdIds]).toEqual([]);
  });

  it('reads a capacity shed of a held charger as pressure, and its own shed as the hold', () => {
    const held = planInput({ kind: 'target_reached', targetPercent: 60 });
    expect(isChargeTargetHoldShed(held, new Map())).toBe(true);
    expect(isChargeTargetHoldShed(held, new Map([
      ['charger', { code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 60 }],
    ]))).toBe(true);
    expect(isChargeTargetHoldShed(held, new Map([['charger', { code: PLAN_REASON_CODES.capacity }]]))).toBe(false);
  });
});

describe('smart task lift (deferred admission)', () => {
  const planned: DeferredAdmissionDecision = {
    kind: 'planned', budgetExempt: false, engageBoost: false, reservesStartupPower: false,
  };
  const idle: DeferredAdmissionDecision = { kind: 'idle', budgetExempt: false, holdCause: 'cheaper_hours' };
  const inactive: DeferredAdmissionDecision = { kind: 'inactive', budgetExempt: false };
  const admit = (hold: ChargeTargetHold, decision: DeferredAdmissionDecision) => (
    applyDeferredAdmissionToInput([planInput(hold)], new Map([['charger', decision]])).devices[0]!
  );

  it('a planned hour lifts the hold', () => {
    const device = admit({ kind: 'target_reached', targetPercent: 30 }, planned);
    expect(device.chargeTargetHoldLifted).toBe(true);
    expect([...resolveChargeTargetHold([device]).holdIds]).toEqual([]);
  });

  it('an idle hour does not lift it', () => {
    const device = admit({ kind: 'target_reached', targetPercent: 30 }, idle);
    expect(device.chargeTargetHoldLifted).toBeUndefined();
    expect([...resolveChargeTargetHold([device]).holdIds]).toEqual(['charger']);
  });

  it('an inactive task does not lift a hold that waits for a level', () => {
    const device = admit({ kind: 'awaiting_level' }, inactive);
    expect(device.chargeTargetHoldLifted).toBeUndefined();
    expect([...resolveChargeTargetHold([device]).holdIds]).toEqual(['charger']);
  });

  it('a planned hour stamps nothing on a charger with no hold', () => {
    expect(admit({ kind: 'none' }, planned).chargeTargetHoldLifted).toBeUndefined();
    expect(admit({ kind: 'below_target', targetPercent: 30 }, planned).chargeTargetHoldLifted).toBeUndefined();
    expect(admit({ kind: 'no_target' }, planned).chargeTargetHoldLifted).toBeUndefined();
    expect(admit({ kind: 'level_unknown' }, planned).chargeTargetHoldLifted).toBeUndefined();
  });
});

describe('a held charger that is already off', () => {
  const planDevice = (fields: Partial<DevicePlanDevice>) => partialDouble<DevicePlanDevice>({
    commandableNow: true, ...fields,
  });

  it('is inactive with the reason naming its target', () => {
    expect(getInactiveReason(planDevice({ chargeTargetHeld: { kind: 'target_reached', targetPercent: 30 } })))
      .toEqual({ code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 30 });
  });

  it('names the target over the start policy where both hold it', () => {
    expect(getInactiveReason(planDevice({
      chargeTargetHeld: { kind: 'awaiting_level' }, startPolicyHoldActive: true,
    }))).toEqual({ code: PLAN_REASON_CODES.awaitingBatteryLevel });
  });
});

describe('charge target reasons', () => {
  const reached = { code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 60 } as const;
  const waiting = { code: PLAN_REASON_CODES.awaitingBatteryLevel } as const;

  it('read the same in the log and on the card, naming the target and never a car', () => {
    expect(formatDeviceReason(reached)).toBe('reached its battery target (60%)');
    expect(formatDeviceReasonUserFacing(reached)).toBe('Reached its battery target (60%)');
    expect(formatDeviceReason(waiting)).toBe('waiting for battery level');
    expect(formatDeviceReasonUserFacing(waiting)).toBe('Waiting for battery level');
  });

  it('compare on the target alone, so they are byte-stable across cycles', () => {
    expect(JSON.stringify(buildComparableDeviceReason(reached)))
      .toBe(JSON.stringify({ code: 'charge_target_reached', targetPercent: 60 }));
    expect(buildComparableDeviceReason(waiting)).toEqual({ code: 'awaiting_battery_level' });
  });
});

describe('normalizeEvChargeTargetSettings', () => {
  it('keeps whole-percent targets and defaults charging before the level is known', () => {
    expect(normalizeEvChargeTargetSettings({
      a: { targetPercent: 80, chargeBeforeLevelKnown: false },
      b: { targetPercent: 60 },
      c: { targetPercent: 59.6, chargeBeforeLevelKnown: 'no' },
    })).toEqual({
      a: { targetPercent: 80, chargeBeforeLevelKnown: false },
      b: { targetPercent: 60, chargeBeforeLevelKnown: true },
      c: { targetPercent: 60, chargeBeforeLevelKnown: true },
    });
  });

  it('drops entries with no usable target', () => {
    expect(normalizeEvChargeTargetSettings({
      zero: { targetPercent: 0 },
      over: { targetPercent: 101 },
      text: { targetPercent: '50' },
      nan: { targetPercent: Number.NaN },
      junk: null,
    })).toEqual({});
    expect(normalizeEvChargeTargetSettings(['x'])).toEqual({});
    expect(normalizeEvChargeTargetSettings(null)).toEqual({});
  });
});
