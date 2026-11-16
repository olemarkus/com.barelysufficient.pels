import type { Schedule } from '../../packages/contracts/src/schedules';
import type { SmartTaskCandidateDevice } from '../../packages/contracts/src/smartTaskEdit';
import {
  parseSchedule, scheduleConflict, scheduleEligibilityIssue, scheduleEligibilityReason,
} from '../../packages/shared-domain/src/settings/schedules';
import { partialDouble } from '../helpers/partialDouble';

const override = (patch: Partial<Schedule> = {}): Schedule => ({
  id: 'bathroom', name: 'Bathroom mornings', enabled: true, at: '06:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'include', modes: ['Home'] },
  action: { type: 'override', deviceId: 'floor', setting: { type: 'temperature', targetC: 26 }, minutes: 60 },
  ...patch,
});
const floor = partialDouble<SmartTaskCandidateDevice>({
  deviceId: 'floor', deviceName: 'Bathroom floor', kind: 'temperature', goalMin: 5, goalMax: 30, goalStep: 0.5,
  unitSymbol: '°C',
});

describe('a scheduled override', () => {
  it('parses to itself', () => {
    expect(parseSchedule(override())).toEqual(override());
  });

  it.each([
    ['no device', { deviceId: '' }],
    ['an unknown setting', { setting: { type: 'fan', speed: 2 } }],
    ['a temperature that is not a number', { setting: { type: 'temperature', targetC: 'warm' } }],
    ['no minutes', { minutes: 0 }],
    ['part of a minute', { minutes: 30.5 }],
    ['more than seven days', { minutes: 7 * 24 * 60 + 1 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseSchedule({ ...override(), action: { ...override().action, ...patch } })).toThrow('Invalid override');
  });

  it('needs its device and a temperature inside the device range', () => {
    expect(scheduleEligibilityIssue(override(), ['Home'], [floor])).toBeNull();
    expect(scheduleEligibilityReason(override(), ['Home'], []))
      .toBe('This device is not available for this override. Edit the schedule.');
    const hot = override({
      action: { type: 'override', deviceId: 'floor', setting: { type: 'temperature', targetC: 35 }, minutes: 60 },
    });
    expect(scheduleEligibilityIssue(hot, ['Home'], [floor])).toBe('target_out_of_range');
  });

  it('conflicts with another override of the same device at the same time, not with its Smart task', () => {
    const task = override({
      id: 'task',
      action: { type: 'task', task: {
        deviceId: 'floor', kind: 'temperature', target: 24, readyByLocalTime: '07:00',
        exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
      } },
    });
    expect(scheduleConflict(override(), [override({ id: 'other' })])).toBe(true);
    expect(scheduleConflict(override(), [task])).toBe(false);
    expect(scheduleConflict(override(), [override({ id: 'other', at: '07:00' })])).toBe(false);
  });
});
