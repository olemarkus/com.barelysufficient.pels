import { describe, expect, it } from 'vitest';
import { rankRestoreCooldownCohort } from '../../lib/plan/planRestoreCooldownCohort';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

// Every lane stamps the same countdown on the devices a global restore
// cooldown holds; this pass decides, once and across lanes, which ONE card
// counts down and which read "other devices are ahead". Pinned on the order
// the restore pass admits in — off candidates, then active stepped increases,
// then setpoint raises, by priority within a lane — not on list order or on
// priority alone.
describe('rankRestoreCooldownCohort', () => {
  const countdown = {
    code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 55, countdownStartedAtMs: 10, countdownTotalSec: 60,
  } as const;
  const keep = { code: PLAN_REASON_CODES.keep, detail: null } as const;

  it('keeps the countdown on the highest-priority held device and queues the rest', () => {
    const ranked = rankRestoreCooldownCohort([
      buildPlanDevice({ id: 'third', priority: 3, plannedState: 'shed', reason: countdown }),
      buildPlanDevice({ id: 'first', priority: 1, plannedState: 'shed', reason: countdown }),
      buildPlanDevice({ id: 'running', priority: 2, reason: keep }),
      buildPlanDevice({ id: 'second', priority: 4, plannedState: 'shed', reason: countdown }),
    ]);

    expect(ranked.map((device) => [device.id, device.reason])).toEqual([
      ['third', { code: PLAN_REASON_CODES.waitingForOtherDevices }],
      ['first', countdown],
      ['running', keep],
      ['second', { code: PLAN_REASON_CODES.waitingForOtherDevices }],
    ]);
  });

  it('follows the admission lanes before priority: an off device resumes before a stepped increase or a setpoint raise', () => {
    const ranked = rankRestoreCooldownCohort([
      buildPlanDevice({
        id: 'thermostat', priority: 1, plannedState: 'shed', shedAction: 'set_temperature', shedTemperature: 16,
        currentTarget: 16, currentTemperature: 16, plannedTarget: 16, reason: countdown,
      }),
      steppedPlanDevice({
        id: 'tank', priority: 2, currentState: 'on', selectedStepId: 'low', desiredStepId: 'low', reason: countdown,
      }),
      buildPlanDevice({ id: 'heater', priority: 3, currentState: 'off', plannedState: 'shed', reason: countdown }),
    ]);

    expect(ranked.map((device) => [device.id, device.reason.code])).toEqual([
      ['thermostat', PLAN_REASON_CODES.waitingForOtherDevices],
      ['tank', PLAN_REASON_CODES.waitingForOtherDevices],
      ['heater', PLAN_REASON_CODES.cooldownRestore],
    ]);
  });

  it('leaves a lone held device counting down, and touches nothing else', () => {
    const devices = [
      buildPlanDevice({ id: 'only', priority: 3, plannedState: 'shed', reason: countdown }),
      buildPlanDevice({ id: 'running', priority: 1, reason: keep }),
    ];

    expect(rankRestoreCooldownCohort(devices)).toBe(devices);
  });
});
