import {
  classificationImpliesStallSatisfied,
  formatIdleClassificationCopy,
} from '../packages/shared-domain/src/idleClassificationCopy';

describe('classificationImpliesStallSatisfied', () => {
  it('treats parked classifications (near_target_idle, capped_idle) as stall-satisfied', () => {
    expect(classificationImpliesStallSatisfied('near_target_idle')).toBe(true);
    expect(classificationImpliesStallSatisfied('capped_idle')).toBe(true);
  });

  it('never treats a fault or the absence of a classification as satisfied', () => {
    expect(classificationImpliesStallSatisfied('unresponsive')).toBe(false);
    expect(classificationImpliesStallSatisfied(undefined)).toBe(false);
  });
});

describe('formatIdleClassificationCopy', () => {
  it('builds a neutral status line for near_target_idle with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'near_target_idle',
      currentTemperatureC: 61.5,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('neutral');
    expect(copy.statusLine).toBe('Holding near setpoint (61.5° / 65°)');
    expect(copy.detail).toContain('61.5° / 65°');
  });

  it('builds a warning status line for unresponsive with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'unresponsive',
      currentTemperatureC: 55,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('warning');
    expect(copy.statusLine).toBe('Not responding (55° / 65°)');
    expect(copy.detail).toContain('breaker');
  });

  it('degrades gracefully when temperatures are missing', () => {
    const copy = formatIdleClassificationCopy({ classification: 'near_target_idle' });
    expect(copy.statusLine).toBe('Holding near setpoint');
    expect(copy.detail).not.toContain('undefined');
  });

  it('does not recommend raising the capacity cap', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'unresponsive',
      currentTemperatureC: 50,
      targetTemperatureC: 70,
    });
    expect(copy.detail.toLowerCase()).not.toMatch(/hard cap|raise/);
  });

  it('builds a neutral status line for capped_idle with temperatures', () => {
    const copy = formatIdleClassificationCopy({
      classification: 'capped_idle',
      currentTemperatureC: 58,
      targetTemperatureC: 65,
    });
    expect(copy.tone).toBe('neutral');
    expect(copy.statusLine).toBe('Device reached its own setpoint cap (58° / 65°)');
    // The detail must name the device's OWN setpoint cap as the recourse
    // surface — never PELS' canonical "hard cap" (per
    // `feedback_hard_cap_is_physical.md`).
    expect(copy.detail).toContain('setpoint cap');
    expect(copy.detail.toLowerCase()).not.toContain('hard cap');
  });

  it('capped_idle degrades gracefully when temperatures are missing', () => {
    const copy = formatIdleClassificationCopy({ classification: 'capped_idle' });
    expect(copy.statusLine).toBe('Device reached its own setpoint cap');
    expect(copy.detail).not.toContain('undefined');
    expect(copy.tone).toBe('neutral');
  });
});
