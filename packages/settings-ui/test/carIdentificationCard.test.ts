import { describe, expect, it } from 'vitest';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemantics.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const charger = (overrides: Record<string, unknown>) => uiDeviceFixture({
  id: 'charger', name: 'Charger', isEvCharger: true, currentState: 'on', plannedState: 'keep', ...overrides,
}, false, 0).status;

describe('a charger still identifying its car', () => {
  it('says it is waiting, then that it gave up, when nothing else explains the card', () => {
    expect(charger({ carIdentificationState: 'waiting' })).toMatchObject({
      reason: { text: 'Waiting to identify the connected car' },
      factText: 'Plugged in · no battery level',
    });
    expect(charger({ carIdentificationState: 'timed_out' })).toMatchObject({
      reason: { text: 'Could not identify the connected car. Confirm it in the charger’s Car section.', tone: 'warning' },
    });
  });

  it('answers the wait for a battery level with the identification line', () => {
    expect(charger({
      carIdentificationState: 'waiting', reason: { code: PLAN_REASON_CODES.awaitingBatteryLevel },
    }).reason).toMatchObject({ text: 'Waiting to identify the connected car' });
  });

  it('keeps the reason of a charger held for capacity', () => {
    const held = { currentState: 'off', plannedState: 'shed', reason: 'shed due to capacity' };
    const unidentified = charger({ ...held, carIdentificationState: 'timed_out' });
    expect(unidentified.reason).toEqual(charger(held).reason);
    expect(unidentified.reason?.text).not.toContain('identify');
  });

  it('says nothing about identification for a charger that is not waiting', () => {
    const status = charger({ carIdentificationState: 'not_waiting' });
    expect(status.reason?.text ?? '').not.toContain('identify');
    expect(status.factText ?? '').not.toContain('battery level');
  });
});
