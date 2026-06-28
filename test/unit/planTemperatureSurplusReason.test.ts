import { describe, expect, it } from 'vitest';
import {
  TEMPERATURE_SURPLUS_REASON,
  resolveTemperatureReasonLine,
} from '../../packages/shared-domain/src/planTemperatureCardText';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemanticsCore';

type ReasonDevice = Parameters<typeof resolveTemperatureReasonLine>[0];

// A managed temperature device actively running and holding a (solar-raised) setpoint —
// kind 'active' (currentState 'on', not shed/resuming), so the surplus branch is reachable.
// `overrides` is loosely typed so test cases can supply a raw reason/state literal.
const activeDevice = (overrides: Record<string, unknown> = {}): ReasonDevice => ({
  id: 'heater-1',
  name: 'Hall Heater',
  currentTemperature: 21,
  plannedTarget: 23,
  currentState: 'on',
  plannedState: 'keep',
  controllable: true,
  available: true,
  reason: { code: PLAN_REASON_CODES.keep },
  ...overrides,
} as unknown as ReasonDevice);

describe('resolveTemperatureReasonLine — surplus-absorb reason', () => {
  it('returns the solar reason when surplus-absorb is the binding cause on an active device', () => {
    expect(resolveTemperatureReasonLine(activeDevice({ surplusAbsorbActive: true })))
      .toBe(TEMPERATURE_SURPLUS_REASON);
  });

  it('shows no reason line when surplus-absorb is inactive (prior behaviour preserved)', () => {
    expect(resolveTemperatureReasonLine(activeDevice({ surplusAbsorbActive: false }))).toBeNull();
  });

  it('does NOT claim solar on an off/idle device (plannedState inactive) — would contradict "Off"', () => {
    expect(resolveTemperatureReasonLine(activeDevice({
      surplusAbsorbActive: true,
      currentState: 'off',
      plannedState: 'inactive',
    }))).toBeNull();
  });

  it('does NOT claim solar on a manual (uncontrolled) device — PELS is not running it', () => {
    expect(resolveTemperatureReasonLine(activeDevice({
      surplusAbsorbActive: true,
      controllable: false,
    }))).toBeNull();
  });

  it('does NOT claim solar on an unavailable (offline) device', () => {
    expect(resolveTemperatureReasonLine(activeDevice({
      surplusAbsorbActive: true,
      currentState: 'unknown',
      available: false,
    }))).toBeNull();
  });

  it('prefers the constraint copy over the solar reason when the device is held (shed)', () => {
    const held = activeDevice({
      surplusAbsorbActive: true,
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.capacity },
    });
    const line = resolveTemperatureReasonLine(held);
    expect(line).not.toBe(TEMPERATURE_SURPLUS_REASON);
    expect(line).not.toBeNull();
  });
});
